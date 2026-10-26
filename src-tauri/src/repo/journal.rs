//! `OpJournal`: undo / redo of the operations of a session (M4-1).
//!
//! Before a journaled write, the job records the local refs (`refs/heads`, `refs/tags`), HEAD,
//! the branch upstreams and, for a mixed reset, the index tree; after it, the same again, and
//! keeps what changed. Discards and hard resets also keep, for each file they touched, its
//! content before (from their backup) and after, as blobs written with `hash-object -w`.
//! An undo puts the "before" side back, a redo the "after" side, through the Git CLI on the
//! repository's queue, after checking that the repository is still exactly on the other side:
//! a ref moved elsewhere is `undoDiverged`, a file changed since is `undoWouldOverwrite`.
//! Fetch (without prune) and the other operations that are not journaled are not barriers:
//! only what the undo would change is checked.
//!
//! The journal is saved in `yaggui.db` after each journaled write, undo and redo, and loaded
//! when the repository opens (F-244). An entry from a previous session goes through the same
//! checks, plus one: every object the step needs must still exist. The saved file contents
//! are unreachable blobs and `git gc` may prune them between sessions; nothing is written into
//! the repository to keep them (spec §8), so such an entry is refused with
//! `undoObjectsMissing` before anything changes.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use gix::ObjectId;
use gix::bstr::{BStr, ByteSlice};
use serde::{Deserialize, Serialize};

use crate::events::{BackendEvent, JournalChanged, OpKind};
use crate::git::errors::{BackendError, YagguiError};
use crate::git::ops::types::{
    JOURNAL_PATHS_MAX, JournalEntry, JournalOp, UndoBlock, UndoState, UndoStep,
};
use crate::git::read::refs::read_stashes;
use crate::git::read::state::gix as gix_err;

use super::history::{STATUS_ARGS, ensure_idle, preview};
use super::ref_ops::{classify, overwritten_paths, raw};
use super::remotes::{RemoteChange, remote_step};
use super::write::{
    IndexSide, MODE_EXECUTABLE, MODE_FILE, MODE_SYMLINK, SavedPath, SavedWorktree, StageEntry,
    WriteContext,
};
use super::{RepoManager, lock};
use crate::store::{JOURNAL_MAX_ENTRIES, Store, StoredJournalRow};

/// Operations kept per repository; the oldest are forgotten first.
const JOURNAL_MAX: usize = JOURNAL_MAX_ENTRIES as usize;
/// Version of the saved `state` encoding: bump it when `Mode` or `Side` change in a way old
/// rows cannot be read with (they are then kept, blocked as `unreadable`).
const STATE_FORMAT: u32 = 1;
/// Files per `git hash-object` invocation.
const HASH_BATCH: usize = 200;

/// How an undo (or redo) moves the repository between the two sides of an operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub(super) enum Mode {
    /// Refs and HEAD's commit only (`update-ref`), the working tree stays; the index takes
    /// its recorded tree back when the operation changed it (mixed reset). Commit, amend,
    /// branch creation / deletion, soft and mixed reset.
    Refs,
    /// HEAD moves to another branch or commit with `git switch`, carrying local changes.
    Switch,
    /// HEAD's commit moves with `git reset --keep`: refused when local changes are in the
    /// way. Merge, cherry-pick, revert.
    Keep,
    /// `Keep` plus the files the reset overwrote; the redo resets `--hard` again.
    HardReset,
    /// Only the files (discard).
    Files,
    /// `git branch -m`, which also moves the branch config and reflog.
    Rename { from: String, to: String },
    /// `git stash store` puts the entry back (on top of the list); the redo drops it again.
    StashDrop {
        #[serde(with = "oid")]
        sha: ObjectId,
        message: String,
    },
    /// A linked worktree at `path` on `checkout` (a branch, or a commit with `detach`), added
    /// by the operation (`added`) or removed. Adding it back recreates the branch first;
    /// removing it is refused while it has local changes. The refs part (a branch created
    /// with the worktree) is undone like `Refs`.
    Worktree {
        path: String,
        checkout: String,
        detach: bool,
        added: bool,
    },
    /// A stash of selected files (`Files` plus the stash entry): the undo writes the files
    /// back and drops the entry, the redo stores the entry again and reverts the files.
    StashPush {
        #[serde(with = "oid")]
        sha: ObjectId,
        message: String,
    },
    /// A remote added, renamed or removed: its config section and tracking refs (M4-7c).
    Remote(RemoteChange),
}

/// What a journaled job reports about the operation it ran.
pub(super) struct Plan {
    pub(super) op: JournalOp,
    pub(super) mode: Mode,
    pub(super) blocked: Option<UndoBlock>,
    /// Files saved before the operation changed them (discard, hard reset).
    pub(super) files: Vec<SavedPath>,
}

impl Plan {
    pub(super) fn new(op: JournalOp, mode: Mode) -> Self {
        Self {
            op,
            mode,
            blocked: None,
            files: Vec::new(),
        }
    }

    /// An operation that can never be undone (push, fetch with prune, pull).
    pub(super) fn blocked(op: JournalOp, reason: UndoBlock) -> Self {
        Self {
            blocked: Some(reason),
            ..Self::new(op, Mode::Refs)
        }
    }

    pub(super) fn with_files(mut self, files: Vec<SavedPath>) -> Self {
        self.files = files;
        self
    }

    /// A discard of the files `saved` holds.
    pub(super) fn discard(saved: Vec<SavedPath>) -> Self {
        let count = u32::try_from(saved.len()).unwrap_or(u32::MAX);
        let paths = saved
            .iter()
            .take(JOURNAL_PATHS_MAX as usize)
            .map(|s| s.path.clone())
            .collect();
        Self::new(JournalOp::Discard { paths, count }, Mode::Files).with_files(saved)
    }
}

/// HEAD: a branch (`commit` is `None` while unborn) or a detached commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Head {
    Branch {
        name: String,
        #[serde(with = "oid::option")]
        commit: Option<ObjectId>,
    },
    Detached(#[serde(with = "oid")] ObjectId),
}

impl Head {
    fn commit(&self) -> Option<ObjectId> {
        match self {
            Self::Branch { commit, .. } => *commit,
            Self::Detached(id) => Some(*id),
        }
    }

    fn branch(&self) -> Option<&str> {
        match self {
            Self::Branch { name, .. } => Some(name),
            Self::Detached(_) => None,
        }
    }
}

/// `branch.<name>.remote` and `.merge`.
type Upstream = (String, String);

/// Local refs, HEAD and upstreams at one point.
struct Snapshot {
    refs: BTreeMap<String, ObjectId>,
    head: Head,
    /// By short branch name.
    upstreams: BTreeMap<String, Upstream>,
    index: Option<ObjectId>,
}

impl Snapshot {
    fn take(repo: &gix::Repository) -> Result<Self, YagguiError> {
        Ok(Self {
            refs: local_refs(repo)?,
            head: read_head(repo)?,
            upstreams: upstreams(repo),
            index: None,
        })
    }
}

/// One file on one side of a discard or hard reset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct FileState {
    path: String,
    worktree: IndexSide,
    index: IndexSide,
}

/// The state an undo or redo leads to, restricted to what the operation changed.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Side {
    /// Full ref name → target (`None`: absent).
    #[serde(with = "oid::map")]
    refs: BTreeMap<String, Option<ObjectId>>,
    /// Upstreams of the branches in `refs`, by short name.
    upstreams: BTreeMap<String, Option<Upstream>>,
    head: Option<Head>,
    /// Index tree, when the operation changed it without touching the files (mixed reset).
    #[serde(with = "oid::option")]
    index: Option<ObjectId>,
    files: Vec<FileState>,
}

#[derive(Debug, Clone)]
struct Record {
    entry: JournalEntry,
    mode: Mode,
    before: Side,
    after: Side,
}

/// What a saved row holds besides the entry (`StoredJournalRow::state`).
#[derive(Serialize)]
struct StateRef<'a> {
    mode: &'a Mode,
    before: &'a Side,
    after: &'a Side,
}

#[derive(Deserialize)]
struct StoredState {
    mode: Mode,
    before: Side,
    after: Side,
}

/// Journal of the operations of one repository, this session's after the restored ones.
#[derive(Default)]
pub struct OpJournal {
    records: VecDeque<Record>,
    /// Ids of the records undone since the last journaled operation, latest last.
    redo: Vec<u32>,
    next_id: u32,
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
        .floor()
}

impl OpJournal {
    /// The journal saved by previous sessions; empty when it cannot be read (logged).
    pub(super) fn load(store: &Store, repo_id: u32) -> Self {
        let rows = match store.load_journal(repo_id, now_ms() as i64) {
            Ok(rows) => rows,
            Err(err) => {
                tracing::warn!(repo_id, error = %err, "undo journal not loaded");
                return Self::default();
            }
        };
        let mut journal = Self::default();
        let mut redo = Vec::new();
        for row in rows {
            journal.next_id = journal.next_id.max(row.seq);
            let mut entry = match serde_json::from_str::<JournalEntry>(&row.entry) {
                Ok(entry) => entry,
                Err(err) => {
                    tracing::warn!(repo_id, seq = row.seq, error = %err, "journal entry skipped");
                    continue;
                }
            };
            entry.id = row.seq;
            entry.at = row.at as f64;
            entry.undone = row.undone;
            entry.restored = true;
            let state = (row.format == STATE_FORMAT)
                .then(|| serde_json::from_str::<StoredState>(&row.state))
                .and_then(Result::ok);
            let (mode, before, after) = match state {
                Some(state) => (state.mode, state.before, state.after),
                None => {
                    entry.blocked.get_or_insert(UndoBlock::Unreadable);
                    (Mode::Refs, Side::default(), Side::default())
                }
            };
            if let Some(order) = row.redo_order {
                redo.push((order, row.seq));
            }
            journal.records.push_back(Record {
                entry,
                mode,
                before,
                after,
            });
        }
        redo.sort_unstable();
        journal.redo = redo.into_iter().map(|(_, seq)| seq).collect();
        journal
    }

    /// Saves the latest record, just journaled (best effort: the write already happened).
    fn save_last(&self, store: &Store, repo_id: u32) {
        let Some(record) = self.records.back() else {
            return;
        };
        let saved = stored_row(record)
            .map_err(|e| e.to_string())
            .and_then(|row| {
                store
                    .append_journal(repo_id, &row, now_ms() as i64)
                    .map_err(|e| e.to_string())
            });
        if let Err(err) = saved {
            tracing::warn!(repo_id, error = %err, "undo journal entry not saved");
        }
    }

    /// Saves an undo or redo of `id` (best effort, like [`save_last`](Self::save_last)).
    fn save_mark(&self, store: &Store, repo_id: u32, id: u32, undone: bool) {
        if let Err(err) = store.mark_journal(repo_id, id, undone, &self.redo) {
            tracing::warn!(repo_id, error = %err, "undo journal position not saved");
        }
    }

    fn push(&mut self, op: JournalOp, blocked: Option<UndoBlock>) -> &mut Record {
        self.next_id += 1;
        let at = now_ms();
        if self.records.len() >= JOURNAL_MAX {
            self.records.pop_front();
        }
        self.redo.clear();
        self.records.push_back(Record {
            entry: JournalEntry {
                id: self.next_id,
                op,
                at,
                undone: false,
                blocked,
                restored: false,
            },
            mode: Mode::Refs,
            before: Side::default(),
            after: Side::default(),
        });
        let last = self.records.len() - 1;
        &mut self.records[last]
    }

    /// Latest record not undone.
    fn undo_target(&self) -> Option<&Record> {
        self.records.iter().rev().find(|r| !r.entry.undone)
    }

    fn redo_target(&self) -> Option<&Record> {
        let id = *self.redo.last()?;
        self.records.iter().find(|r| r.entry.id == id)
    }

    fn mark(&mut self, id: u32, undone: bool) -> Option<JournalEntry> {
        let record = self.records.iter_mut().find(|r| r.entry.id == id)?;
        record.entry.undone = undone;
        if undone {
            self.redo.push(id);
        } else {
            self.redo.retain(|r| *r != id);
        }
        Some(record.entry.clone())
    }

    /// Newest first; `blocked` also says when what an entry needs was pruned since.
    fn history(&self, repo: &gix::Repository) -> Vec<JournalEntry> {
        self.records
            .iter()
            .rev()
            .map(|r| {
                let mut entry = r.entry.clone();
                if entry.blocked.is_none() {
                    entry.blocked = objects_block(repo, r, !r.entry.undone);
                }
                entry
            })
            .collect()
    }
}

fn stored_row(record: &Record) -> Result<StoredJournalRow, serde_json::Error> {
    Ok(StoredJournalRow {
        seq: record.entry.id,
        at: record.entry.at as i64,
        undone: record.entry.undone,
        redo_order: None,
        entry: serde_json::to_string(&record.entry)?,
        format: STATE_FORMAT,
        state: serde_json::to_string(&StateRef {
            mode: &record.mode,
            before: &record.before,
            after: &record.after,
        })?,
    })
}

/// Hex object ids in the saved state.
pub(super) mod oid {
    use std::collections::BTreeMap;

    use gix::ObjectId;
    use serde::de::Error;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(id: &ObjectId, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(id)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<ObjectId, D::Error> {
        parse::<D>(&String::deserialize(d)?)
    }

    fn parse<'de, D: Deserializer<'de>>(hex: &str) -> Result<ObjectId, D::Error> {
        ObjectId::from_hex(hex.as_bytes()).map_err(D::Error::custom)
    }

    pub mod option {
        use super::*;

        pub fn serialize<S: Serializer>(id: &Option<ObjectId>, s: S) -> Result<S::Ok, S::Error> {
            match id {
                Some(id) => s.collect_str(id),
                None => s.serialize_none(),
            }
        }

        pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<ObjectId>, D::Error> {
            Option::<String>::deserialize(d)?
                .map(|hex| parse::<D>(&hex))
                .transpose()
        }
    }

    pub mod map {
        use super::*;
        use serde::Serialize;

        type Refs = BTreeMap<String, Option<ObjectId>>;

        pub fn serialize<S: Serializer>(refs: &Refs, s: S) -> Result<S::Ok, S::Error> {
            refs.iter()
                .map(|(name, id)| (name, id.map(|id| id.to_string())))
                .collect::<BTreeMap<_, _>>()
                .serialize(s)
        }

        pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Refs, D::Error> {
            BTreeMap::<String, Option<String>>::deserialize(d)?
                .into_iter()
                .map(|(name, hex)| Ok((name, hex.map(|h| parse::<D>(&h)).transpose()?)))
                .collect()
        }
    }
}

// --- Recording ---------------------------------------------------------------------------

impl RepoManager {
    /// Runs `job` like [`write_op`](Self::write_op) and journals the operation it describes
    /// (`None`: nothing to journal, e.g. already up to date). `capture_index` also records the
    /// index tree before and after (mixed reset).
    pub(super) fn journal_op<T: Send + 'static>(
        &self,
        repo_id: u32,
        kind: OpKind,
        cancellable: bool,
        capture_index: bool,
        job: impl FnOnce(&WriteContext<'_>) -> Result<(T, Option<Plan>), YagguiError> + Send + 'static,
    ) -> Result<T, YagguiError> {
        self.journal_outcome(repo_id, kind, cancellable, capture_index, move |ctx| {
            job(ctx).map(|(value, plan)| (Ok(value), plan))
        })
    }

    /// Like [`journal_op`](Self::journal_op), for an operation that can fail after changing
    /// what it journals (a conflict): the plan is journaled either way, and the inner error is
    /// the operation's outcome (`op-finished` failed), the undo staying available.
    pub(super) fn journal_outcome<T: Send + 'static>(
        &self,
        repo_id: u32,
        kind: OpKind,
        cancellable: bool,
        capture_index: bool,
        job: impl FnOnce(
            &WriteContext<'_>,
        ) -> Result<(Result<T, YagguiError>, Option<Plan>), YagguiError>
        + Send
        + 'static,
    ) -> Result<T, YagguiError> {
        let session = self.session(repo_id)?;
        let store = Arc::clone(&self.store);
        let recorded = Arc::new(AtomicBool::new(false));
        let job_recorded = Arc::clone(&recorded);
        let outcome = self.write_op(repo_id, kind, cancellable, move |ctx| {
            let before = take_before(ctx, capture_index);
            let (outcome, plan) = job(ctx)?;
            if let Some(plan) = plan {
                let mut journal = lock(&session.journal);
                if record(ctx, &mut journal, before, plan) {
                    journal.save_last(&store, repo_id);
                    job_recorded.store(true, Ordering::Relaxed);
                }
            }
            outcome
        });
        // After `op-finished`, success or not: the journal has the entry by then.
        if recorded.load(Ordering::Relaxed) {
            self.sink
                .emit(BackendEvent::JournalChanged(JournalChanged { repo_id }));
        }
        outcome
    }
}

fn take_before(ctx: &WriteContext<'_>, capture_index: bool) -> Result<Snapshot, YagguiError> {
    let mut snapshot = Snapshot::take(ctx.repo)?;
    if capture_index {
        snapshot.index = Some(write_tree(ctx)?);
    }
    Ok(snapshot)
}

/// Adds the operation to the journal; `false` when it changed nothing worth journaling.
fn record(
    ctx: &WriteContext<'_>,
    journal: &mut OpJournal,
    before: Result<Snapshot, YagguiError>,
    plan: Plan,
) -> bool {
    if plan.blocked.is_some() {
        journal.push(plan.op, plan.blocked);
        return true;
    }
    match sides(ctx, before, &plan) {
        Ok(None) => false,
        Ok(Some((before, after))) => {
            let record = journal.push(plan.op, None);
            record.mode = plan.mode;
            record.before = before;
            record.after = after;
            true
        }
        Err(err) => {
            tracing::warn!(repo_id = ctx.repo_id, error = %err, "operation not recorded for undo");
            journal.push(plan.op, Some(UndoBlock::NotRecorded));
            true
        }
    }
}

/// The two sides of the operation, `None` when it changed nothing.
fn sides(
    ctx: &WriteContext<'_>,
    before: Result<Snapshot, YagguiError>,
    plan: &Plan,
) -> Result<Option<(Side, Side)>, YagguiError> {
    let before = before?;
    // Config changes (upstreams) are only seen by a reloaded handle.
    let mut repo = ctx.repo.clone();
    repo.reload()
        .map_err(|e| BackendError::gix("reload the repository", e))?;
    let mut after = Snapshot::take(&repo)?;
    if before.index.is_some() {
        after.index = Some(write_tree(ctx)?);
    }
    let names: BTreeSet<&String> = before.refs.keys().chain(after.refs.keys()).collect();
    let mut b = Side::default();
    let mut a = Side::default();
    for name in names {
        let (old, new) = (before.refs.get(name), after.refs.get(name));
        if old == new {
            continue;
        }
        b.refs.insert(name.clone(), old.copied());
        a.refs.insert(name.clone(), new.copied());
        if let Some(short) = name.strip_prefix("refs/heads/") {
            b.upstreams
                .insert(short.to_owned(), before.upstreams.get(short).cloned());
            a.upstreams
                .insert(short.to_owned(), after.upstreams.get(short).cloned());
        }
    }
    if before.head != after.head {
        b.head = Some(before.head.clone());
        a.head = Some(after.head.clone());
    }
    if before.index != after.index {
        b.index = before.index;
        a.index = after.index;
    }
    let (files_before, files_after) = file_sides(ctx, &plan.files)?;
    b.files = files_before;
    a.files = files_after;
    let changed = !a.refs.is_empty()
        || a.head.is_some()
        || a.index.is_some()
        || b.files != a.files
        || matches!(
            plan.mode,
            Mode::StashDrop { .. } | Mode::Remote(_) | Mode::Worktree { .. }
        );
    if !changed {
        return Ok(None);
    }
    // Moving the working tree needs a commit on both sides (not an unborn branch).
    let moves_worktree = matches!(plan.mode, Mode::Switch | Mode::Keep | Mode::HardReset);
    if moves_worktree && (before.head.commit().is_none() || after.head.commit().is_none()) {
        return Err(BackendError::Invariant("HEAD has no commit on one side".into()).into());
    }
    Ok(Some((b, a)))
}

/// Files before (from the backup) and after the operation, their content written as blobs.
fn file_sides(
    ctx: &WriteContext<'_>,
    saved: &[SavedPath],
) -> Result<(Vec<FileState>, Vec<FileState>), YagguiError> {
    if saved.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let backup_files: Vec<PathBuf> = saved
        .iter()
        .filter_map(|s| match &s.worktree {
            SavedWorktree::File { file, .. } => Some(file.clone()),
            _ => None,
        })
        .collect();
    let mut ids = hash_objects(ctx, &backup_files)?.into_iter();
    let index = open_index(ctx.repo)?;
    let mut before = Vec::new();
    let mut after = Vec::new();
    for s in saved {
        let worktree = match &s.worktree {
            SavedWorktree::Unmanaged => IndexSide::Unmanaged,
            SavedWorktree::Absent => IndexSide::Absent,
            SavedWorktree::File { mode, .. } => IndexSide::Blob {
                id: ids.next().ok_or_else(|| {
                    YagguiError::from(BackendError::Invariant("hash-object output".into()))
                })?,
                mode: *mode,
            },
        };
        before.push(FileState {
            path: s.path.clone(),
            worktree,
            index: s.index,
        });
        let current_worktree = match s.worktree {
            SavedWorktree::Unmanaged => IndexSide::Unmanaged,
            _ => write_worktree_blob(ctx, &s.path)?,
        };
        let current_index = match s.index {
            IndexSide::Unmanaged => IndexSide::Unmanaged,
            _ => index_side(&index, &s.path),
        };
        after.push(FileState {
            path: s.path.clone(),
            worktree: current_worktree,
            index: current_index,
        });
    }
    Ok((before, after))
}

// --- Reading the state ---------------------------------------------------------------------

/// `refs/heads/*` and `refs/tags/*`, not peeled.
fn local_refs(repo: &gix::Repository) -> Result<BTreeMap<String, ObjectId>, YagguiError> {
    let mut refs = BTreeMap::new();
    let platform = repo.references().map_err(gix_err("list refs"))?;
    for reference in platform.all().map_err(gix_err("list refs"))? {
        let reference = reference.map_err(gix_err("list refs"))?;
        let name = reference.name().as_bstr().to_str_lossy();
        if !(name.starts_with("refs/heads/") || name.starts_with("refs/tags/")) {
            continue;
        }
        if let gix::refs::TargetRef::Object(id) = reference.target() {
            refs.insert(name.into_owned(), id.to_owned());
        }
    }
    Ok(refs)
}

fn read_head(repo: &gix::Repository) -> Result<Head, YagguiError> {
    let head = repo.head().map_err(gix_err("read HEAD"))?;
    let commit = head.id().map(gix::Id::detach);
    Ok(match head.referent_name() {
        Some(name) => Head::Branch {
            name: name.as_bstr().to_str_lossy().into_owned(),
            commit,
        },
        None => Head::Detached(commit.ok_or_else(|| YagguiError::revision_not_found("HEAD"))?),
    })
}

fn upstreams(repo: &gix::Repository) -> BTreeMap<String, Upstream> {
    let config = repo.config_snapshot();
    let mut out = BTreeMap::new();
    let Some(sections) = config.plumbing().sections_by_name("branch") else {
        return out;
    };
    for section in sections {
        let Some(name) = section.header().subsection_name() else {
            continue;
        };
        let remote = section.value("remote");
        let merge = section.value("merge");
        if let (Some(remote), Some(merge)) = (remote, merge) {
            out.insert(
                name.to_str_lossy().into_owned(),
                (
                    remote.to_str_lossy().into_owned(),
                    merge.to_str_lossy().into_owned(),
                ),
            );
        }
    }
    out
}

/// A fresh read of `.git/index`: gix's shared snapshot can miss a rewrite within the same
/// mtime tick, and the journal compares entries right after Git wrote them.
fn open_index(repo: &gix::Repository) -> Result<gix::index::File, YagguiError> {
    match repo.open_index() {
        Ok(index) => Ok(index),
        Err(_) if !repo.index_path().exists() => Ok(gix::index::File::from_state(
            gix::index::State::new(repo.object_hash()),
            repo.index_path(),
        )),
        Err(e) => Err(BackendError::gix("read the index", e).into()),
    }
}

fn index_side(index: &gix::index::File, path: &str) -> IndexSide {
    use gix::index::entry::Stage;

    let key = BStr::new(path.as_bytes());
    let entries = index
        .entry_range(key)
        .map_or(&[][..], |range| &index.entries()[range]);
    if entries.iter().any(|e| e.stage() != Stage::Unconflicted) {
        let mut stages = [None; 3];
        for entry in entries {
            let slot = match entry.stage() {
                Stage::Base => 0,
                Stage::Ours => 1,
                Stage::Theirs => 2,
                Stage::Unconflicted => continue,
            };
            stages[slot] = Some(StageEntry {
                id: entry.id,
                mode: entry.mode.bits(),
            });
        }
        return IndexSide::Unmerged { stages };
    }
    match index.entry_by_path(key) {
        Some(entry) if entry.mode.is_submodule() => IndexSide::Unmanaged,
        Some(entry) => IndexSide::Blob {
            id: entry.id,
            mode: entry.mode.bits(),
        },
        None => IndexSide::Absent,
    }
}

/// The working tree file at `path`: its content and mode, read in process (no blob written).
fn worktree_side(ctx: &WriteContext<'_>, path: &str) -> Result<IndexSide, YagguiError> {
    let Some((data, mode)) = read_worktree(ctx.workdir, path)? else {
        return Ok(match std::fs::symlink_metadata(ctx.workdir.join(path)) {
            Ok(_) => IndexSide::Unmanaged,
            Err(_) => IndexSide::Absent,
        });
    };
    let id = gix::objs::compute_hash(ctx.repo.object_hash(), gix::object::Kind::Blob, &data)
        .map_err(|e| BackendError::gix("hash a file", e))?;
    Ok(IndexSide::Blob { id, mode })
}

/// Content and mode of a file or symlink (its target); `None` when absent or not a file.
fn read_worktree(workdir: &Path, path: &str) -> Result<Option<(Vec<u8>, u32)>, YagguiError> {
    let full = workdir.join(path);
    let io = |e| {
        YagguiError::from(BackendError::io(
            format!("cannot read {}", full.display()),
            e,
        ))
    };
    match std::fs::symlink_metadata(&full) {
        Ok(meta) if meta.file_type().is_symlink() => {
            let target = std::fs::read_link(&full).map_err(io)?;
            Ok(Some((
                target.to_string_lossy().as_bytes().to_vec(),
                MODE_SYMLINK,
            )))
        }
        Ok(meta) if meta.is_file() => {
            let data = std::fs::read(&full).map_err(io)?;
            let mode = if super::write::is_executable(&full) {
                MODE_EXECUTABLE
            } else {
                MODE_FILE
            };
            Ok(Some((data, mode)))
        }
        Ok(_) => Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io(e)),
    }
}

/// Like [`worktree_side`], writing the content as a blob so a redo can put it back.
fn write_worktree_blob(ctx: &WriteContext<'_>, path: &str) -> Result<IndexSide, YagguiError> {
    let Some((data, mode)) = read_worktree(ctx.workdir, path)? else {
        return worktree_side(ctx, path);
    };
    let out = ctx.run(
        &ctx.command(["hash-object", "-w", "--no-filters", "--stdin"])
            .stdin(data),
    )?;
    Ok(IndexSide::Blob {
        id: parse_id(out.stdout.trim())?,
        mode,
    })
}

/// `git hash-object -w --no-filters` on files (absolute paths), in order.
fn hash_objects(ctx: &WriteContext<'_>, files: &[PathBuf]) -> Result<Vec<ObjectId>, YagguiError> {
    let mut ids = Vec::with_capacity(files.len());
    for batch in files.chunks(HASH_BATCH) {
        let mut command = ctx.command(["hash-object", "-w", "--no-filters", "--"]);
        for file in batch {
            command = command.arg(file);
        }
        let out = ctx.run(&command)?;
        for line in out.stdout.lines().filter(|l| !l.trim().is_empty()) {
            ids.push(parse_id(line.trim())?);
        }
    }
    if ids.len() != files.len() {
        return Err(BackendError::Invariant("hash-object output".into()).into());
    }
    Ok(ids)
}

fn write_tree(ctx: &WriteContext<'_>) -> Result<ObjectId, YagguiError> {
    let out = ctx.run(&ctx.command(["write-tree"]))?;
    parse_id(out.stdout.trim())
}

fn parse_id(hex: &str) -> Result<ObjectId, YagguiError> {
    ObjectId::from_hex(hex.as_bytes())
        .map_err(|_| BackendError::Invariant(format!("not an object id: {hex}")).into())
}

// --- Undo / redo ---------------------------------------------------------------------------

impl RepoManager {
    pub fn undo(&self, repo_id: u32) -> Result<JournalEntry, YagguiError> {
        self.undo_redo(repo_id, true)
    }

    pub fn redo(&self, repo_id: u32) -> Result<JournalEntry, YagguiError> {
        self.undo_redo(repo_id, false)
    }

    fn undo_redo(&self, repo_id: u32, undo: bool) -> Result<JournalEntry, YagguiError> {
        let session = self.session(repo_id)?;
        let store = Arc::clone(&self.store);
        let kind = if undo { OpKind::Undo } else { OpKind::Redo };
        let entry = self.write_op(repo_id, kind, false, move |ctx| {
            let record = {
                let journal = lock(&session.journal);
                let target = if undo {
                    journal.undo_target()
                } else {
                    journal.redo_target()
                };
                target.cloned().ok_or_else(|| {
                    if undo {
                        YagguiError::nothing_to_undo()
                    } else {
                        YagguiError::nothing_to_redo()
                    }
                })?
            };
            step(ctx, &record, undo)?;
            let mut journal = lock(&session.journal);
            let entry = journal.mark(record.entry.id, undo).ok_or_else(|| {
                YagguiError::from(BackendError::Invariant("journal entry vanished".into()))
            })?;
            journal.save_mark(&store, repo_id, entry.id, undo);
            Ok(entry)
        })?;
        self.sink
            .emit(BackendEvent::JournalChanged(JournalChanged { repo_id }));
        Ok(entry)
    }

    pub fn undo_state(&self, repo_id: u32) -> Result<UndoState, YagguiError> {
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        let current = Snapshot::take(&repo)?;
        let journal = lock(&session.journal);
        let step = |record: Option<&Record>, undo: bool| {
            record.map(|record| {
                let (from, to) = sides_of(record, undo);
                let moved = moved_refs(&current, from, to);
                UndoStep {
                    entry: record.entry.clone(),
                    blocked: record
                        .entry
                        .blocked
                        .clone()
                        .or_else(|| objects_block(&repo, record, undo))
                        .or_else(|| {
                            (!moved.is_empty()).then_some(UndoBlock::Diverged { refs: moved })
                        }),
                }
            })
        };
        Ok(UndoState {
            undo: step(journal.undo_target(), true),
            redo: step(journal.redo_target(), false),
        })
    }

    pub fn op_history(&self, repo_id: u32) -> Result<Vec<JournalEntry>, YagguiError> {
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        Ok(lock(&session.journal).history(&repo))
    }
}

/// `objectsMissing` when objects the step needs are no longer in the repository.
fn objects_block(repo: &gix::Repository, record: &Record, undo: bool) -> Option<UndoBlock> {
    let count = missing_objects(repo, record, undo);
    (count > 0).then_some(UndoBlock::ObjectsMissing { count })
}

/// How many of the objects the step writes back are gone: the targets of the refs and HEAD,
/// the index tree, the file contents, and the stash, tracking refs or detached commit the mode
/// restores. Only the objects themselves are looked up: `git gc` prunes an unreachable commit
/// with its trees, never one without the other.
fn missing_objects(repo: &gix::Repository, record: &Record, undo: bool) -> u32 {
    if record.entry.blocked.is_some() {
        return 0;
    }
    let (_, to) = sides_of(record, undo);
    let mut needed: BTreeSet<ObjectId> = to.refs.values().flatten().copied().collect();
    needed.extend(to.head.as_ref().and_then(Head::commit));
    needed.extend(to.index);
    for file in &to.files {
        for side in [file.worktree, file.index] {
            match side {
                IndexSide::Blob { id, .. } => {
                    needed.insert(id);
                }
                IndexSide::Unmerged { stages } => {
                    needed.extend(stages.iter().flatten().map(|s| s.id))
                }
                IndexSide::Unmanaged | IndexSide::Absent => {}
            }
        }
    }
    let parse = |hex: &str| ObjectId::from_hex(hex.as_bytes()).ok();
    match &record.mode {
        Mode::StashDrop { sha, .. } if undo => {
            needed.insert(*sha);
        }
        Mode::StashPush { sha, .. } if !undo => {
            needed.insert(*sha);
        }
        Mode::Remote(RemoteChange::Removed { tracking, .. }) if undo => {
            needed.extend(tracking.iter().filter_map(|r| parse(&r.sha)));
        }
        Mode::Worktree {
            checkout,
            detach: true,
            added,
            ..
        } if *added != undo => {
            needed.extend(parse(checkout));
        }
        _ => {}
    }
    let missing = needed.iter().filter(|id| !repo.has_object(id)).count();
    u32::try_from(missing).unwrap_or(u32::MAX)
}

/// (from, to): where the repository must be, and where the step takes it.
fn sides_of(record: &Record, undo: bool) -> (&Side, &Side) {
    if undo {
        (&record.after, &record.before)
    } else {
        (&record.before, &record.after)
    }
}

/// Refs (and HEAD) the step changes that are no longer as the operation left them.
fn moved_refs(current: &Snapshot, from: &Side, to: &Side) -> Vec<String> {
    let mut moved: Vec<String> = from
        .refs
        .iter()
        .filter(|(name, target)| current.refs.get(*name).copied() != **target)
        .map(|(name, _)| name.clone())
        .collect();
    if let (Some(from_head), Some(_)) = (&from.head, &to.head)
        && *from_head != current.head
    {
        moved.push("HEAD".to_owned());
    }
    moved
}

fn step(ctx: &WriteContext<'_>, record: &Record, undo: bool) -> Result<(), YagguiError> {
    if let Some(reason) = &record.entry.blocked {
        return Err(YagguiError::undo_blocked(reason.clone()));
    }
    // Before anything else: a step that cannot finish must not start.
    let missing = missing_objects(ctx.repo, record, undo);
    if missing > 0 {
        return Err(YagguiError::undo_objects_missing(missing));
    }
    let (from, to) = sides_of(record, undo);
    if !matches!(
        record.mode,
        Mode::Files | Mode::StashDrop { .. } | Mode::StashPush { .. } | Mode::Remote(_)
    ) {
        ensure_idle(ctx)?;
    }
    let current = Snapshot::take(ctx.repo)?;
    let moved = moved_refs(&current, from, to);
    if !moved.is_empty() {
        return Err(YagguiError::undo_diverged(moved, Vec::new()));
    }
    let message = format!("yaggui: {}", if undo { "undo" } else { "redo" });
    match &record.mode {
        Mode::Refs => {
            check_index(ctx, from, to)?;
            update_refs(ctx, from, to, &message, None, |_| true)?;
            move_detached_head(ctx, from, to, &message)?;
            if let Some(tree) = to.index.filter(|_| from.index != to.index) {
                ctx.run(&ctx.command(["read-tree".to_owned(), tree.to_string()]))?;
                refresh_index(ctx);
            }
            fix_upstreams(ctx, from, to)
        }
        Mode::Switch => {
            update_refs(ctx, from, to, &message, None, Option::is_some)?;
            switch_head(ctx, to)?;
            update_refs(ctx, from, to, &message, None, Option::is_none)?;
            fix_upstreams(ctx, from, to)
        }
        Mode::Keep => keep(ctx, from, to, &message),
        Mode::HardReset if undo => {
            check_files(ctx, from)?;
            keep(ctx, from, to, &message)?;
            write_files(ctx, &to.files)
        }
        Mode::HardReset => {
            check_files(ctx, from)?;
            // A reset to HEAD itself only dropped local changes: HEAD is in neither side.
            let target = match current.head.commit() {
                Some(id) if to.head.is_none() => id,
                _ => head_commit(to)?,
            };
            let status = ctx.run(&ctx.command(STATUS_ARGS))?.stdout;
            let known: BTreeSet<&str> = from.files.iter().map(|f| f.path.as_str()).collect();
            let extra: Vec<String> = preview(ctx.repo, target, &status)?
                .hard_lost
                .into_iter()
                .map(|f| f.path)
                .filter(|p| !known.contains(p.as_str()))
                .collect();
            if !extra.is_empty() {
                return Err(YagguiError::undo_would_overwrite(extra));
            }
            ctx.run(&ctx.command(["reset", "-q", "--hard", &target.to_string(), "--"]))
                .map(drop)
        }
        Mode::Files => {
            check_files(ctx, from)?;
            write_files(ctx, &to.files)
        }
        Mode::Worktree {
            path,
            checkout,
            detach,
            added,
        } => {
            if *added == undo {
                remove_worktree(ctx, path)?;
                update_refs(ctx, from, to, &message, None, |_| true)?;
                fix_upstreams(ctx, from, to)
            } else {
                update_refs(ctx, from, to, &message, None, |_| true)?;
                fix_upstreams(ctx, from, to)?;
                add_worktree(ctx, path, checkout, *detach)
            }
        }
        Mode::Rename { from: old, to: new } => {
            let (current_name, target_name) = if undo { (new, old) } else { (old, new) };
            ctx.run(&ctx.command(["branch", "-m", "--", current_name, target_name]))
                .map(drop)
        }
        Mode::StashPush { sha, message: text } => stash_push_step(ctx, from, to, *sha, text, undo),
        Mode::Remote(change) => remote_step(ctx, change, undo),
        Mode::StashDrop { sha, message: text } => {
            let position = read_stashes(ctx.repo)?
                .iter()
                .position(|entry| entry.id == *sha);
            if undo {
                if position.is_some() {
                    return Err(YagguiError::undo_diverged(
                        vec!["refs/stash".to_owned()],
                        Vec::new(),
                    ));
                }
                ctx.run(&ctx.command([
                    "stash".to_owned(),
                    "store".to_owned(),
                    "-q".to_owned(),
                    format!("--message={text}"),
                    sha.to_string(),
                ]))
                .map(drop)
            } else {
                let Some(index) = position else {
                    return Err(YagguiError::undo_diverged(
                        vec!["refs/stash".to_owned()],
                        Vec::new(),
                    ));
                };
                ctx.run(&ctx.command([
                    "stash".to_owned(),
                    "drop".to_owned(),
                    "-q".to_owned(),
                    format!("stash@{{{index}}}"),
                ]))
                .map(drop)
            }
        }
    }
}

/// Removes a worktree an undo or redo takes away: only without local changes (they would be
/// lost), like `git worktree remove` without `--force`.
fn remove_worktree(ctx: &WriteContext<'_>, path: &str) -> Result<(), YagguiError> {
    if Path::new(path).exists() {
        let worktree = gix::open(path).map_err(|e| BackendError::gix("open the worktree", e))?;
        let status = crate::git::read::diff::WorktreeStatus::read(&worktree)?;
        if !status.dirty().is_clean() {
            return Err(YagguiError::undo_would_overwrite(vec![path.to_owned()]));
        }
    }
    let run = raw(ctx, &ctx.command(["worktree", "remove", "--"]).arg(path))?;
    if run.success {
        Ok(())
    } else {
        Err(classify(ctx, &run))
    }
}

/// Puts back a worktree: its folder must be absent or empty.
fn add_worktree(
    ctx: &WriteContext<'_>,
    path: &str,
    checkout: &str,
    detach: bool,
) -> Result<(), YagguiError> {
    if std::fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_some()) {
        return Err(YagguiError::undo_would_overwrite(vec![path.to_owned()]));
    }
    let mut command = ctx.command(["worktree", "add"]);
    if detach {
        command = command.arg("--detach");
    }
    let run = raw(ctx, &command.arg("--").arg(path).arg(checkout))?;
    if run.success {
        Ok(())
    } else {
        Err(classify(ctx, &run))
    }
}

/// Undo: the files go back as they were, then the entry is dropped (if that fails, the
/// changes are in both places, never lost). Redo: the entry is stored again, then the files
/// are reverted as the stash left them.
fn stash_push_step(
    ctx: &WriteContext<'_>,
    from: &Side,
    to: &Side,
    sha: ObjectId,
    text: &str,
    undo: bool,
) -> Result<(), YagguiError> {
    let diverged = || YagguiError::undo_diverged(vec!["refs/stash".to_owned()], Vec::new());
    let position = read_stashes(ctx.repo)?
        .iter()
        .position(|entry| entry.id == sha);
    check_files(ctx, from)?;
    if undo {
        let index = position.ok_or_else(diverged)?;
        write_files(ctx, &to.files)?;
        ctx.run(&ctx.command([
            "stash".to_owned(),
            "drop".to_owned(),
            "-q".to_owned(),
            format!("stash@{{{index}}}"),
        ]))
        .map(drop)
    } else {
        if position.is_some() {
            return Err(diverged());
        }
        ctx.run(&ctx.command([
            "stash".to_owned(),
            "store".to_owned(),
            "-q".to_owned(),
            format!("--message={text}"),
            sha.to_string(),
        ]))?;
        write_files(ctx, &to.files)
    }
}

fn head_commit(side: &Side) -> Result<ObjectId, YagguiError> {
    side.head
        .as_ref()
        .and_then(Head::commit)
        .ok_or_else(|| BackendError::Invariant("no HEAD commit to move to".into()).into())
}

/// `git reset --keep` to the commit of `to` (it moves HEAD's branch), then the other refs.
fn keep(ctx: &WriteContext<'_>, from: &Side, to: &Side, message: &str) -> Result<(), YagguiError> {
    let mut moved_branch = None;
    if to.head.is_some() {
        let target = head_commit(to)?;
        let run = raw(
            ctx,
            &ctx.command(["reset", "-q", "--keep", &target.to_string(), "--"]),
        )?;
        if !run.success {
            return Err(
                refused_by_local_changes(ctx, &run.stderr).unwrap_or_else(|| classify(ctx, &run))
            );
        }
        moved_branch = from.head.as_ref().and_then(Head::branch);
    }
    update_refs(ctx, from, to, message, moved_branch, |_| true)?;
    fix_upstreams(ctx, from, to)
}

/// HEAD to the branch or commit of `to`, with `git switch` (carries local changes).
fn switch_head(ctx: &WriteContext<'_>, to: &Side) -> Result<(), YagguiError> {
    let Some(head) = &to.head else {
        return Ok(());
    };
    let args = match head {
        Head::Branch { name, .. } => vec![
            "switch".to_owned(),
            "--no-guess".to_owned(),
            name.strip_prefix("refs/heads/").unwrap_or(name).to_owned(),
        ],
        Head::Detached(id) => vec!["switch".to_owned(), "--detach".to_owned(), id.to_string()],
    };
    let run = raw(ctx, &ctx.command(args))?;
    if run.success {
        return Ok(());
    }
    Err(refused_by_local_changes(ctx, &run.stderr).unwrap_or_else(|| classify(ctx, &run)))
}

/// `undoWouldOverwrite` when Git refused to overwrite local changes.
fn refused_by_local_changes(ctx: &WriteContext<'_>, stderr: &str) -> Option<YagguiError> {
    let mut paths: BTreeSet<String> = overwritten_paths(stderr)
        .unwrap_or_default()
        .into_iter()
        .collect();
    // `reset --keep`: "error: Entry 'path' not uptodate. Cannot merge."
    for line in stderr.lines() {
        if let Some(rest) = line.split("Entry '").nth(1)
            && let Some((path, tail)) = rest.split_once('\'')
            && tail.contains("not uptodate")
        {
            paths.insert(path.to_owned());
        }
    }
    let refused =
        !paths.is_empty() || overwritten_paths(stderr).is_some() || stderr.contains("not uptodate");
    if !refused {
        return None;
    }
    let mut paths: Vec<String> = paths.into_iter().collect();
    if paths.is_empty() {
        paths = super::ref_ops::worktree_status(ctx)
            .map(|s| s.tracked.into_iter().collect())
            .unwrap_or_default();
    }
    Some(YagguiError::undo_would_overwrite(paths).with_detail(stderr))
}

/// One `update-ref --stdin` transaction for the refs of `to` that `keep_target` selects
/// (by their new value), except `skip`, checking each one still has its `from` value.
fn update_refs(
    ctx: &WriteContext<'_>,
    from: &Side,
    to: &Side,
    message: &str,
    skip: Option<&str>,
    keep_target: impl Fn(&Option<ObjectId>) -> bool,
) -> Result<(), YagguiError> {
    let mut stdin = Vec::new();
    for (name, new) in &to.refs {
        if !keep_target(new) || Some(name.as_str()) == skip {
            continue;
        }
        let old = from.refs.get(name).copied().flatten();
        let line = match (new, old) {
            (Some(new), Some(old)) => format!("update {name}\0{new}\0{old}\0"),
            (Some(new), None) => format!("create {name}\0{new}\0"),
            (None, Some(old)) => format!("delete {name}\0{old}\0"),
            (None, None) => continue,
        };
        stdin.extend_from_slice(line.as_bytes());
    }
    if stdin.is_empty() {
        return Ok(());
    }
    let run = raw(
        ctx,
        &ctx.command(["update-ref", "-m", message, "--stdin", "-z"])
            .stdin(stdin),
    )?;
    if run.success {
        return Ok(());
    }
    if run.stderr.contains("but expected") || run.stderr.contains("reference already exists") {
        let names = to.refs.keys().cloned().collect();
        return Err(YagguiError::undo_diverged(names, Vec::new()).with_detail(&run.stderr));
    }
    Err(classify(ctx, &run))
}

/// A detached HEAD moved by the operation (commit on a detached HEAD) goes back.
fn move_detached_head(
    ctx: &WriteContext<'_>,
    from: &Side,
    to: &Side,
    message: &str,
) -> Result<(), YagguiError> {
    if let (Some(Head::Detached(old)), Some(Head::Detached(new))) = (&from.head, &to.head)
        && old != new
    {
        ctx.run(&ctx.command([
            "update-ref".to_owned(),
            "--no-deref".to_owned(),
            "-m".to_owned(),
            message.to_owned(),
            "HEAD".to_owned(),
            new.to_string(),
            old.to_string(),
        ]))?;
    }
    Ok(())
}

/// Upstreams of the branches the step creates (as recorded) or deletes (config removed).
fn fix_upstreams(ctx: &WriteContext<'_>, from: &Side, to: &Side) -> Result<(), YagguiError> {
    for (branch, upstream) in &to.upstreams {
        let name = format!("refs/heads/{branch}");
        let created = from.refs.get(&name).is_some_and(Option::is_none)
            && to.refs.get(&name).is_some_and(Option::is_some);
        let deleted = to.refs.get(&name).is_some_and(Option::is_none);
        if created && let Some((remote, merge)) = upstream {
            for (key, value) in [("remote", remote), ("merge", merge)] {
                ctx.run(&ctx.command([
                    "config".to_owned(),
                    format!("branch.{branch}.{key}"),
                    value.clone(),
                ]))?;
            }
        } else if deleted && from.upstreams.get(branch).is_some_and(Option::is_some) {
            for key in ["remote", "merge"] {
                // Exit code 5 when the key is already gone: fine.
                raw(
                    ctx,
                    &ctx.command(["config", "--unset", &format!("branch.{branch}.{key}")]),
                )?;
            }
        }
    }
    Ok(())
}

/// Refuses when the index differs from the tree `from` recorded (staged changes since).
fn check_index(ctx: &WriteContext<'_>, from: &Side, to: &Side) -> Result<(), YagguiError> {
    let (Some(expected), Some(_)) = (from.index, to.index) else {
        return Ok(());
    };
    if from.index == to.index {
        return Ok(());
    }
    let current = match write_tree(ctx) {
        Ok(tree) => tree,
        Err(_) => return Err(YagguiError::unresolved_conflicts()),
    };
    if current == expected {
        return Ok(());
    }
    let out = ctx.run(&ctx.command([
        "diff-tree".to_owned(),
        "-r".to_owned(),
        "--name-only".to_owned(),
        "-z".to_owned(),
        expected.to_string(),
        current.to_string(),
    ]))?;
    let paths = out
        .stdout
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect();
    Err(YagguiError::undo_would_overwrite(paths))
}

/// Refuses when a file is no longer as `from` recorded it (changed since).
fn check_files(ctx: &WriteContext<'_>, from: &Side) -> Result<(), YagguiError> {
    if from.files.is_empty() {
        return Ok(());
    }
    let index = open_index(ctx.repo)?;
    let mut changed = Vec::new();
    for file in &from.files {
        let worktree_ok = file.worktree == IndexSide::Unmanaged
            || worktree_side(ctx, &file.path)? == file.worktree;
        let index_ok =
            file.index == IndexSide::Unmanaged || index_side(&index, &file.path) == file.index;
        if !worktree_ok || !index_ok {
            changed.push(file.path.clone());
        }
    }
    if changed.is_empty() {
        Ok(())
    } else {
        Err(YagguiError::undo_would_overwrite(changed))
    }
}

/// Puts files back: working tree content from the blobs, index entries with
/// `update-index --index-info`.
fn write_files(ctx: &WriteContext<'_>, files: &[FileState]) -> Result<(), YagguiError> {
    let mut entries = Vec::new();
    for file in files {
        let full = ctx.workdir.join(&file.path);
        match file.worktree {
            IndexSide::Unmanaged | IndexSide::Unmerged { .. } => {}
            IndexSide::Absent => remove_file(&full)?,
            IndexSide::Blob { id, mode } => {
                let object = ctx
                    .repo
                    .find_object(id)
                    .map_err(|e| BackendError::gix("read a saved file", e))?;
                write_worktree_file(&full, &object.data, mode)?;
            }
        }
        match file.index {
            IndexSide::Unmanaged => {}
            IndexSide::Absent => {
                entries.extend_from_slice(
                    format!(
                        "0 {}\t{}\0",
                        ObjectId::null(ctx.repo.object_hash()),
                        file.path
                    )
                    .as_bytes(),
                );
            }
            IndexSide::Blob { id, mode } => {
                entries.extend_from_slice(format!("{mode:o} {id}\t{}\0", file.path).as_bytes());
            }
            IndexSide::Unmerged { stages } => {
                // The stage 0 entry goes first, then the stages are added back.
                let null = ObjectId::null(ctx.repo.object_hash());
                entries.extend_from_slice(format!("0 {null}\t{}\0", file.path).as_bytes());
                for (stage, entry) in (1..).zip(stages) {
                    if let Some(StageEntry { id, mode }) = entry {
                        entries.extend_from_slice(
                            format!("{mode:o} {id} {stage}\t{}\0", file.path).as_bytes(),
                        );
                    }
                }
            }
        }
    }
    if !entries.is_empty() {
        ctx.run(
            &ctx.command(["update-index", "-z", "--index-info"])
                .stdin(entries),
        )?;
    }
    refresh_index(ctx);
    Ok(())
}

/// Refreshes the stat data of the index after files were rewritten (best effort).
fn refresh_index(ctx: &WriteContext<'_>) {
    if let Err(err) = raw(ctx, &ctx.command(["update-index", "-q", "--refresh"])) {
        tracing::debug!(error = %err, "index refresh failed");
    }
}

fn remove_file(full: &Path) -> Result<(), YagguiError> {
    match std::fs::symlink_metadata(full) {
        Ok(meta) if !meta.is_dir() => std::fs::remove_file(full)
            .map_err(|e| BackendError::io(format!("cannot remove {}", full.display()), e).into()),
        _ => Ok(()),
    }
}

fn write_worktree_file(full: &Path, data: &[u8], mode: u32) -> Result<(), YagguiError> {
    let io = |e| {
        YagguiError::from(BackendError::io(
            format!("cannot write {}", full.display()),
            e,
        ))
    };
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(io)?;
    }
    // A symlink is replaced, never written through.
    remove_file(full)?;
    // No exec bit on Windows, and symlinks are written as plain files holding the target, as
    // Git does with `core.symlinks=false`.
    #[cfg(not(unix))]
    let _ = mode;
    #[cfg(unix)]
    if mode == MODE_SYMLINK {
        let target = std::ffi::OsStr::new(data.to_str().map_err(|_| {
            YagguiError::from(BackendError::Invariant(
                "symlink target is not UTF-8".into(),
            ))
        })?);
        return std::os::unix::fs::symlink(target, full).map_err(io);
    }
    std::fs::write(full, data).map_err(io)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let bits = if mode == MODE_EXECUTABLE {
            0o755
        } else {
            0o644
        };
        std::fs::set_permissions(full, std::fs::Permissions::from_mode(bits)).map_err(io)?;
    }
    Ok(())
}
