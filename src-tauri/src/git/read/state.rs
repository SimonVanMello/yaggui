//! Repository state summary: HEAD, upstream, dirty counts, operation in progress.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::git::errors::{BackendError, YagguiError};
use crate::git::read::diff::WorktreeStatus;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HeadState {
    /// HEAD points to a branch that has at least one commit.
    #[serde(rename_all = "camelCase")]
    Branch { name: String, oid: String },
    /// HEAD points to a branch without commits yet (fresh `git init`).
    Unborn { name: String },
    /// HEAD points directly to a commit.
    Detached { oid: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamState {
    /// Short name of the tracking branch, e.g. `origin/main`.
    pub name: String,
    /// Commits on the local branch missing from the upstream.
    pub ahead: u32,
    /// Commits on the upstream missing from the local branch.
    pub behind: u32,
    /// The upstream is configured but its ref no longer exists (deleted on the remote and pruned).
    pub gone: bool,
}

/// Number of changed paths, by kind, as the changes panel lists them (untracked files one by
/// one, a rename once). A path staged and modified again counts in both.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DirtyState {
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicted: u32,
}

impl DirtyState {
    pub fn is_clean(&self) -> bool {
        self.staged == 0 && self.unstaged == 0 && self.untracked == 0 && self.conflicted == 0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RepoOperation {
    /// `MERGE_HEAD` present, or a `--squash` merge whose commit is still to be made
    /// (`SQUASH_MSG`, Git keeps no other trace of it).
    Merge {
        squash: bool,
    },
    #[serde(rename_all = "camelCase")]
    Rebase {
        /// Git ≥ 2.26 runs plain rebases through the interactive machinery, so this is
        /// also `true` for most non-interactive rebases; only a hint.
        interactive: bool,
        /// 1-based index of the step being applied, when known.
        step: Option<u32>,
        total: Option<u32>,
        /// Branch being rebased, when known (`feature/x`).
        head_name: Option<String>,
    },
    CherryPick,
    Revert,
    Bisect,
    /// `git am` / mailbox apply.
    ApplyMailbox,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IndexLockState {
    pub path: String,
    pub age_secs: u32,
    /// Old enough (> 10 s) to be probably left over by a crashed process.
    pub stale: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
    pub head: HeadState,
    /// `None` when HEAD is detached/unborn or the branch has no upstream.
    pub upstream: Option<UpstreamState>,
    pub dirty: DirtyState,
    pub operation: Option<RepoOperation>,
    pub index_lock: Option<IndexLockState>,
}

/// How old an `index.lock` must be to be considered left over by a crashed process.
pub const STALE_LOCK_SECS: u32 = 10;

/// `map_err` adapter turning a gix error into a `YagguiError`, keeping its causes.
pub(crate) fn gix<E>(context: &'static str) -> impl FnOnce(E) -> YagguiError
where
    E: std::error::Error + Send + Sync + 'static,
{
    move |err| BackendError::gix(context, err).into()
}

/// Reads the full state summary. Cost is dominated by the dirty-files scan (`gix` status).
pub fn read_state(repo: &gix::Repository) -> Result<RepoState, YagguiError> {
    let dirty = match repo.workdir() {
        Some(_) => WorktreeStatus::read(repo)?.dirty(),
        None => DirtyState::default(),
    };
    read_state_with(repo, dirty)
}

/// The state summary with dirty counts already known (from a shared status).
pub fn read_state_with(
    repo: &gix::Repository,
    dirty: DirtyState,
) -> Result<RepoState, YagguiError> {
    let head = read_head(repo)?;
    let upstream = match &head {
        HeadState::Branch { .. } => read_upstream(repo)?,
        _ => None,
    };
    Ok(RepoState {
        head,
        upstream,
        dirty,
        operation: read_operation(repo),
        index_lock: read_index_lock(repo.path()),
    })
}

pub fn read_head(repo: &gix::Repository) -> Result<HeadState, YagguiError> {
    let head = repo.head().map_err(gix("read HEAD"))?;
    Ok(match head.kind {
        gix::head::Kind::Symbolic(reference) => match reference.target.try_id() {
            Some(id) => HeadState::Branch {
                name: reference.name.shorten().to_string(),
                oid: id.to_string(),
            },
            None => HeadState::Unborn {
                name: reference.name.shorten().to_string(),
            },
        },
        gix::head::Kind::Unborn(name) => HeadState::Unborn {
            name: name.shorten().to_string(),
        },
        gix::head::Kind::Detached { target, .. } => HeadState::Detached {
            oid: target.to_string(),
        },
    })
}

fn read_upstream(repo: &gix::Repository) -> Result<Option<UpstreamState>, YagguiError> {
    let Some(branch) = repo.head_name().map_err(gix("read HEAD"))? else {
        return Ok(None);
    };
    let tracking = match repo
        .branch_remote_tracking_ref_name(branch.as_ref(), gix::remote::Direction::Fetch)
    {
        None => return Ok(None),
        Some(Err(err)) => {
            // Broken upstream config must not prevent opening the repo.
            tracing::warn!(error = %err, "cannot resolve the upstream branch");
            return Ok(None);
        }
        Some(Ok(name)) => name,
    };
    let name = tracking.shorten().to_string();
    let upstream_ref = repo
        .try_find_reference(tracking.as_ref())
        .map_err(gix("find upstream"))?;
    let Some(mut upstream_ref) = upstream_ref else {
        return Ok(Some(UpstreamState {
            name,
            ahead: 0,
            behind: 0,
            gone: true,
        }));
    };
    let upstream_id = match upstream_ref.target() {
        gix::refs::TargetRef::Object(id) => id.to_owned(),
        gix::refs::TargetRef::Symbolic(_) => upstream_ref
            .peel_to_id()
            .map_err(gix("peel upstream"))?
            .detach(),
    };
    let local_id = repo.head_id().map_err(gix("read HEAD"))?.detach();
    let counted =
        super::ahead_behind::Counter::new(repo).and_then(|mut c| c.count(local_id, upstream_id));
    let (ahead, behind) = match counted {
        Some(counts) => counts,
        None => {
            let counts = count_exclusive(repo, local_id, upstream_id)
                .and_then(|ahead| Ok((ahead, count_exclusive(repo, upstream_id, local_id)?)));
            match counts {
                Ok(counts) => counts,
                Err(err) => {
                    // An unreadable commit behind the upstream (a remote-tracking ref left
                    // pointing at a pruned object, a partial clone): the repository opens
                    // without an upstream state rather than not at all, like the refs list.
                    tracing::warn!(upstream = %name, error = %err, "upstream state unavailable");
                    return Ok(None);
                }
            }
        }
    };
    Ok(Some(UpstreamState {
        name,
        ahead,
        behind,
        gone: false,
    }))
}

/// Number of commits reachable from `tip` but not from `hidden`.
pub(crate) fn count_exclusive(
    repo: &gix::Repository,
    tip: gix::ObjectId,
    hidden: gix::ObjectId,
) -> Result<u32, YagguiError> {
    if tip == hidden {
        return Ok(0);
    }
    let walk = repo
        .rev_walk([tip])
        .with_hidden([hidden])
        .all()
        .map_err(gix("walk history"))?;
    let mut count = 0u32;
    for info in walk {
        info.map_err(gix("walk history"))?;
        count = count.saturating_add(1);
    }
    Ok(count)
}

pub fn read_operation(repo: &gix::Repository) -> Option<RepoOperation> {
    use gix::state::InProgress;

    let git_dir = repo.path();
    let Some(state) = repo.state() else {
        // A multi-commit cherry-pick or revert whose current commit was committed by hand:
        // no `CHERRY_PICK_HEAD` any more, the rest waits in the sequencer.
        if let Ok(todo) = std::fs::read_to_string(git_dir.join("sequencer/todo")) {
            match todo.split_whitespace().next() {
                Some("pick" | "p") => return Some(RepoOperation::CherryPick),
                Some("revert") => return Some(RepoOperation::Revert),
                _ => {}
            }
        }
        return git_dir
            .join("SQUASH_MSG")
            .is_file()
            .then_some(RepoOperation::Merge { squash: true });
    };
    Some(match state {
        InProgress::ApplyMailbox => RepoOperation::ApplyMailbox,
        // gix looks at `BISECT_LOG` before `REVERT_HEAD`: a revert stopped on conflicts
        // while bisecting is the operation to finish first (`git status` says so too).
        InProgress::Bisect if git_dir.join("REVERT_HEAD").is_file() => RepoOperation::Revert,
        InProgress::Bisect => RepoOperation::Bisect,
        InProgress::CherryPick | InProgress::CherryPickSequence => RepoOperation::CherryPick,
        InProgress::Merge => RepoOperation::Merge { squash: false },
        InProgress::Revert | InProgress::RevertSequence => RepoOperation::Revert,
        InProgress::Rebase | InProgress::RebaseInteractive | InProgress::ApplyMailboxRebase => {
            let merge_dir = git_dir.join("rebase-merge");
            let (dir, step_file, total_file) = if merge_dir.is_dir() {
                (merge_dir, "msgnum", "end")
            } else {
                (git_dir.join("rebase-apply"), "next", "last")
            };
            let read = |name: &str| std::fs::read_to_string(dir.join(name)).ok();
            let number = |name: &str| read(name).and_then(|s| s.trim().parse::<u32>().ok());
            RepoOperation::Rebase {
                interactive: dir.join("interactive").is_file(),
                step: number(step_file),
                total: number(total_file),
                head_name: read("head-name").map(|s| {
                    let s = s.trim();
                    s.strip_prefix("refs/heads/").unwrap_or(s).to_owned()
                }),
            }
        }
    })
}

pub fn read_index_lock(git_dir: &std::path::Path) -> Option<IndexLockState> {
    let path = git_dir.join("index.lock");
    let metadata = std::fs::metadata(&path).ok()?;
    let age = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .map_or(0, |age| u32::try_from(age.as_secs()).unwrap_or(u32::MAX));
    Some(IndexLockState {
        path: path.display().to_string(),
        age_secs: age,
        stale: age > STALE_LOCK_SECS,
    })
}
