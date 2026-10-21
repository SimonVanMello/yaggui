//! `RepoManager`, `RepoSession`, `OpQueue` and `Watcher`.

mod commit_tools;
mod config;
pub mod create;
mod graph_tools;
mod history;
mod inspect;
mod interactive;
mod journal;
mod modules;
mod network;
pub mod op_queue;
mod ref_ops;
mod remotes;
pub mod scan;
pub mod watcher;
pub mod workspace;
mod write;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{
    Arc, Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard, Weak,
};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::events::{BackendEvent, EventSink, GraphProgress, OpKind};
use crate::git::cli::{GitCli, GitCommand};
use crate::git::errors::{BackendError, ErrorCode, YagguiError};
use crate::git::ops::commit_graph;
use crate::git::read::diff::types::{ChangedFiles, DiffTarget};
use crate::git::read::diff::{self, WorktreeStatus};
use crate::git::read::refs::{self, RepoRefs};
use crate::git::read::state::{self, DirtyState, RepoState};
use crate::graph::{
    self, GraphCache,
    types::{CommitDetail, CommitSearch, GraphLocation, GraphPage, SearchChunk},
};
use crate::store::Store;
use op_queue::{OpHandle, OpQueue};
use watcher::Watcher;

/// An open repository, as returned by `open_repo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Stable id (persisted), used by every repo-scoped command and event.
    pub id: u32,
    /// Absolute path of the worktree root.
    pub path: String,
    pub name: String,
    pub state: RepoState,
    /// Set (code `watchUnavailable`) when the repository could not be watched: no
    /// `status-changed` / `refs-changed` events, the UI must offer a manual refresh.
    pub watch_error: Option<YagguiError>,
}

/// How sessions watch their repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchMode {
    Enabled,
    Disabled,
    /// Simulates a watcher that cannot start (tests of the degraded mode).
    Failing(String),
}

/// Modification stamps of the config files, to notice edits made outside yaggui.
type ConfigStamp = Vec<Option<(SystemTime, u64)>>;

/// How long a status read can serve other requests, at most. Requests made for the same
/// change (the repo state and both file lists, refetched together on `status-changed`) share
/// one scan; the bound keeps changes the watcher cannot see (a submodule's own HEAD) from
/// being hidden for longer than before the cache existed.
const STATUS_REUSE: Duration = Duration::from_millis(500);

/// A status read, valid while no change was reported since it started.
struct CachedStatus {
    generation: u64,
    started: Instant,
    status: Arc<WorktreeStatus>,
}

/// What identifies one version of `.git/index`. gix reloads its shared index snapshot only
/// when the mtime grows: a rewrite within the same mtime tick (coarse timestamps: FAT,
/// network shares) would go unnoticed. Size, inode and ctime catch it (git writes the index
/// through a rename, so a new file).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct IndexStamp {
    modified: Option<SystemTime>,
    len: u64,
    #[cfg(unix)]
    inode: (u64, i64, i64),
}

impl IndexStamp {
    fn read(path: &Path) -> Option<Self> {
        let meta = std::fs::metadata(path).ok()?;
        Some(Self {
            modified: meta.modified().ok(),
            len: meta.len(),
            #[cfg(unix)]
            inode: {
                use std::os::unix::fs::MetadataExt;
                (meta.ino(), meta.ctime(), meta.ctime_nsec())
            },
        })
    }
}

/// One open repository: read handle, write queue and watcher.
pub struct RepoSession {
    pub id: u32,
    pub workdir: PathBuf,
    pub name: String,
    /// gix snapshots the configuration when opening: reloaded when a config file changes.
    repo: RwLock<gix::ThreadSafeRepository>,
    config_files: Vec<PathBuf>,
    config_stamp: Mutex<ConfigStamp>,
    /// Set by the watcher when a config file changed (covers same-mtime edits).
    config_changed: Arc<AtomicBool>,
    /// Last `.git/index` seen through [`repo`](Self::repo).
    index_stamp: Mutex<Option<IndexStamp>>,
    /// Bumped by the watcher as soon as a file changes (before its debounce), and after each
    /// operation: a status read started before the bump is not reused.
    status_generation: Arc<AtomicU64>,
    /// Last status read; its lock is held while reading, so concurrent requests share it.
    status_cache: Mutex<Option<CachedStatus>>,
    git_dir: PathBuf,
    queue: OpQueue,
    /// Commit graph of the current refs, recomputed lazily when they change.
    graph: GraphCache,
    /// Set once a commit-graph write was queued, so a session asks for at most one (reset
    /// when a user operation preempts it).
    commit_graph_queued: AtomicBool,
    /// Hash of the ref targets, reused while the watcher reports no refs change (`None`:
    /// to compute). Only used when the repository is watched.
    ref_targets: Mutex<Option<u64>>,
    /// Raised by the watcher when refs changed on disk.
    refs_changed: Arc<AtomicBool>,
    /// Ahead/behind counts and peeled tags, kept across refs listings.
    refs_cache: Mutex<refs::RefsCache>,
    watch_error: Option<YagguiError>,
    /// Operations of this session, for undo / redo.
    journal: Mutex<journal::OpJournal>,
    _watcher: Option<Watcher>,
}

impl RepoSession {
    pub fn state(&self) -> Result<RepoState, YagguiError> {
        let repo = self.repo()?.to_thread_local();
        let dirty = match repo.workdir() {
            Some(_) => self.worktree_status(&repo)?.dirty(),
            None => DirtyState::default(),
        };
        state::read_state_with(&repo, dirty)
    }

    /// Index and working tree changes, shared by the requests made for the same change. Only
    /// reused when the watcher sees every folder: otherwise nothing tells it is outdated.
    pub fn worktree_status(
        &self,
        repo: &gix::Repository,
    ) -> Result<Arc<WorktreeStatus>, YagguiError> {
        if !self._watcher.as_ref().is_some_and(Watcher::is_complete) {
            return Ok(Arc::new(WorktreeStatus::read(repo)?));
        }
        let mut cached = lock(&self.status_cache);
        let generation = self.status_generation.load(Ordering::SeqCst);
        if let Some(entry) = cached.as_ref()
            && entry.generation == generation
            && entry.started.elapsed() < STATUS_REUSE
        {
            return Ok(Arc::clone(&entry.status));
        }
        let started = Instant::now();
        let status = Arc::new(WorktreeStatus::read(repo)?);
        *cached = Some(CachedStatus {
            generation,
            started,
            status: Arc::clone(&status),
        });
        Ok(status)
    }

    /// The gix handle, reloaded first if the configuration changed since the last read, or
    /// if the index changed in a way gix's own check (a newer mtime) misses.
    pub fn repo(&self) -> Result<gix::ThreadSafeRepository, YagguiError> {
        let stamp = config_stamp(&self.config_files);
        let changed = self.config_changed.swap(false, Ordering::SeqCst);
        let index = IndexStamp::read(&self.git_dir.join("index"));
        let index_missed = {
            let mut seen = lock(&self.index_stamp);
            let missed = matches!((*seen, index), (Some(old), Some(new))
                if old != new && old.modified.is_some() && new.modified <= old.modified);
            *seen = index;
            missed
        };
        if index_missed {
            tracing::debug!(repo_id = self.id, "index rewritten without a newer mtime");
        }
        {
            let mut current = lock(&self.config_stamp);
            if changed || index_missed || *current != stamp {
                let mut local = read(&self.repo).to_thread_local();
                local
                    .reload()
                    .map_err(|e| BackendError::gix("reload the repository", e))?;
                *write(&self.repo) = local.into_sync();
                *current = stamp;
                tracing::debug!(repo_id = self.id, "repository handle reloaded");
            }
        }
        Ok(read(&self.repo).clone())
    }

    pub fn git_dir(&self) -> &Path {
        &self.git_dir
    }

    pub fn queue(&self) -> &OpQueue {
        &self.queue
    }

    /// Refs fingerprint. With a watcher, the costly part (every ref target) is only read
    /// again after it reported a refs change.
    pub fn fingerprint(&self, repo: &gix::Repository) -> Result<u64, YagguiError> {
        if !self._watcher.as_ref().is_some_and(Watcher::is_complete) {
            return refs::refs_fingerprint(repo);
        }
        let mut cached = lock(&self.ref_targets);
        // Cleared before reading: a change during the read raises it again.
        let changed = self.refs_changed.swap(false, Ordering::SeqCst);
        let targets = match *cached {
            Some(targets) if !changed => targets,
            _ => {
                let targets = refs::ref_targets_hash(repo)?;
                *cached = Some(targets);
                targets
            }
        };
        drop(cached);
        refs::fingerprint_with(repo, targets)
    }

    /// The graph of the current refs.
    pub fn snapshot(&self, repo: &gix::Repository) -> Result<Arc<graph::Snapshot>, YagguiError> {
        self.graph.snapshot_at(repo, self.fingerprint(repo)?)
    }

    /// Reads the graph of the current refs with `read`. When commit dates misled the history
    /// walk meanwhile (`Snapshot::is_broken`, rows may be missing), reads again from the
    /// rebuilt graph.
    pub fn read_graph<T>(
        &self,
        repo: &gix::Repository,
        read: impl Fn(&Arc<graph::Snapshot>) -> Result<T, YagguiError>,
    ) -> Result<T, YagguiError> {
        let snapshot = self.snapshot(repo)?;
        let result = read(&snapshot)?;
        if !snapshot.is_broken() {
            return Ok(result);
        }
        read(&self.snapshot(repo)?)
    }

    /// Watches registered by the watcher, `None` when the repository is not watched.
    pub fn watched_dirs(&self) -> Option<usize> {
        self._watcher.as_ref().map(Watcher::watched_dirs)
    }

    fn info(&self) -> Result<RepoInfo, YagguiError> {
        Ok(RepoInfo {
            id: self.id,
            path: display_path(&self.workdir),
            name: self.name.clone(),
            state: self.state()?,
            watch_error: self.watch_error.clone(),
        })
    }
}

struct OpenSession {
    session: Arc<RepoSession>,
    /// Number of `open` calls not yet balanced by `close` (one per tab showing the repo).
    refs: usize,
}

/// Owns the open sessions (one per repository, shared by every tab showing it).
pub struct RepoManager {
    git: Arc<GitCli>,
    store: Arc<Store>,
    sink: Arc<dyn EventSink>,
    sessions: Mutex<HashMap<u32, OpenSession>>,
    watch: WatchMode,
    /// Where discards save what they remove (`<app config>/backups`).
    backup_dir: Option<PathBuf>,
    /// Queue of the writes that belong to no repository (global Git config), created on use.
    global_queue: Mutex<Option<Arc<OpQueue>>>,
    /// Cancel tokens of the long reads (blame, file history).
    reads: inspect::ReadTokens,
}

impl RepoManager {
    pub fn new(git: Arc<GitCli>, store: Arc<Store>, sink: Arc<dyn EventSink>) -> Self {
        Self {
            git,
            store,
            sink,
            sessions: Mutex::default(),
            watch: WatchMode::Enabled,
            backup_dir: None,
            global_queue: Mutex::default(),
            reads: inspect::ReadTokens::default(),
        }
    }

    /// Folder of the discard backups. Without it, discards are refused.
    pub fn with_backup_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.backup_dir = Some(dir.into());
        self
    }

    pub fn with_watch_mode(mut self, watch: WatchMode) -> Self {
        self.watch = watch;
        self
    }

    /// Disables filesystem watching (tests that drive events manually).
    pub fn without_watcher(self) -> Self {
        self.with_watch_mode(WatchMode::Disabled)
    }

    /// Opens the repository containing `path`, or joins its existing session. Each call
    /// must be balanced by a `close` (sessions are reference-counted, one per tab).
    pub fn open(&self, path: &str) -> Result<RepoInfo, YagguiError> {
        self.open_with(path, true)
    }

    /// `open`, recording the opening in the recent repos only if `touch` (a background
    /// operation of a workspace does not make the repo recent).
    fn open_with(&self, path: &str, touch: bool) -> Result<RepoInfo, YagguiError> {
        let requested = Path::new(path);
        if path.trim().is_empty() || !requested.is_absolute() {
            return Err(YagguiError::invalid_argument(
                format!("Expected an absolute folder path, got \"{path}\"."),
                format!("Chemin de dossier absolu attendu, reçu « {path} »."),
            ));
        }
        if !requested.exists() {
            return Err(YagguiError::repo_not_found(path));
        }

        let repo = gix::ThreadSafeRepository::discover(requested)
            .map_err(|err| YagguiError::not_a_repository(path).with_detail(err.to_string()))?;
        let Some(workdir) = repo.work_dir().map(normalize) else {
            return Err(YagguiError::invalid_argument(
                "Bare repositories are not supported yet.",
                "Les dépôts nus ne sont pas encore pris en charge.",
            ));
        };
        self.check_safe_directory(&repo, &workdir)?;

        let shown = display_path(&workdir);
        let name = workdir
            .file_name()
            .map_or_else(|| shown.clone(), |n| n.to_string_lossy().into_owned());
        let id = if touch {
            self.store.touch_repo(&shown, &name)?
        } else {
            self.store.ensure_repo(&shown, &name)?
        };

        if let Some(session) = self.acquire(id) {
            return session.info();
        }

        let local = repo.to_thread_local();
        let git_dir = local.git_dir().to_path_buf();
        let config_files = vec![
            local.common_dir().join("config"),
            git_dir.join("config.worktree"),
        ];
        drop(local);
        let config_changed = Arc::new(AtomicBool::new(false));
        let refs_changed = Arc::new(AtomicBool::new(false));
        let status_generation = Arc::new(AtomicU64::new(0));
        let (watcher, watch_error) = match &self.watch {
            WatchMode::Disabled => (None, None),
            WatchMode::Failing(reason) => (None, Some(YagguiError::watch_unavailable(reason))),
            WatchMode::Enabled => match Watcher::start(
                id,
                repo.clone(),
                Arc::clone(&self.sink),
                Arc::clone(&config_changed),
                Arc::clone(&refs_changed),
                Arc::clone(&status_generation),
            ) {
                Ok(watcher) => (Some(watcher), None),
                Err(err) => {
                    tracing::warn!(repo_id = id, error = %err, "repository not watched");
                    (None, Some(err))
                }
            },
        };
        let session = Arc::new(RepoSession {
            id,
            workdir,
            name,
            repo: RwLock::new(repo),
            config_stamp: Mutex::new(config_stamp(&config_files)),
            config_files,
            config_changed,
            index_stamp: Mutex::new(IndexStamp::read(&git_dir.join("index"))),
            status_cache: Mutex::default(),
            git_dir,
            queue: OpQueue::new(id, Arc::clone(&self.sink), Arc::clone(&status_generation))?,
            status_generation,
            graph: {
                let graph = GraphCache::default();
                graph.set_filter(self.store.graph_filter(id)?);
                let sink = Arc::clone(&self.sink);
                graph.set_listener(Arc::new(move |progress: graph::WalkProgress| {
                    sink.emit(BackendEvent::GraphProgress(GraphProgress {
                        repo_id: id,
                        version: progress.version,
                        total_rows: progress.total_rows,
                        exact: progress.exact,
                        stale: progress.stale,
                    }));
                }));
                graph
            },
            commit_graph_queued: AtomicBool::new(false),
            ref_targets: Mutex::default(),
            refs_changed,
            refs_cache: Mutex::default(),
            watch_error,
            journal: Mutex::new(journal::OpJournal::load(&self.store, id)),
            _watcher: watcher,
        });
        let info = session.info()?;
        // Another call may have opened it meanwhile: join that session instead.
        let mut sessions = lock(&self.sessions);
        let entry = sessions
            .entry(id)
            .or_insert(OpenSession { session, refs: 0 });
        entry.refs += 1;
        drop(sessions);
        tracing::info!(repo_id = id, path = %shown, "repository opened");
        Ok(info)
    }

    /// Takes a reference on an already open session.
    fn acquire(&self, repo_id: u32) -> Option<Arc<RepoSession>> {
        let mut sessions = lock(&self.sessions);
        let entry = sessions.get_mut(&repo_id)?;
        entry.refs += 1;
        Some(Arc::clone(&entry.session))
    }

    /// Releases one reference; the last one drops the session (stops its watcher and
    /// queue). Unknown ids are ignored.
    pub fn close(&self, repo_id: u32) {
        let mut sessions = lock(&self.sessions);
        let Some(entry) = sessions.get_mut(&repo_id) else {
            return;
        };
        entry.refs = entry.refs.saturating_sub(1);
        if entry.refs == 0
            && let Some(entry) = sessions.remove(&repo_id)
        {
            entry.session.queue.shutdown();
            tracing::info!(repo_id, "repository closed");
        }
    }

    /// Drops the session whatever its reference count (repo removed from the list).
    pub fn close_all(&self, repo_id: u32) {
        if let Some(entry) = lock(&self.sessions).remove(&repo_id) {
            entry.session.queue.shutdown();
        }
    }

    pub fn get(&self, repo_id: u32) -> Option<Arc<RepoSession>> {
        lock(&self.sessions)
            .get(&repo_id)
            .map(|entry| Arc::clone(&entry.session))
    }

    pub fn session(&self, repo_id: u32) -> Result<Arc<RepoSession>, YagguiError> {
        self.get(repo_id)
            .ok_or_else(|| YagguiError::repo_not_open(repo_id))
    }

    pub fn state(&self, repo_id: u32) -> Result<RepoState, YagguiError> {
        self.session(repo_id)?.state()
    }

    /// Changed files of `target`; index and working tree targets share the session's status.
    pub fn changed_files(
        &self,
        repo_id: u32,
        target: &DiffTarget,
    ) -> Result<ChangedFiles, YagguiError> {
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        match target {
            DiffTarget::Commits { .. } => diff::changed_files(&repo, target),
            DiffTarget::Staged | DiffTarget::Unstaged => {
                diff::changed_files_in(&repo, target, &*session.worktree_status(&repo)?)
            }
        }
    }

    pub fn cancel_op(&self, op_id: u32) -> Result<(), YagguiError> {
        let sessions: Vec<_> = lock(&self.sessions)
            .values()
            .map(|entry| Arc::clone(&entry.session))
            .collect();
        if sessions.iter().any(|s| s.queue.cancel(op_id)) {
            Ok(())
        } else {
            Err(YagguiError::op_not_found(op_id))
        }
    }

    /// Queues the removal of a stale `index.lock`. A fresh lock is refused: a Git
    /// process is probably still running.
    pub fn remove_stale_index_lock(&self, repo_id: u32) -> Result<OpHandle, YagguiError> {
        let session = self.session(repo_id)?;
        let git_dir = session.git_dir().to_path_buf();
        session
            .queue
            .enqueue(OpKind::Maintenance, false, move |_ctx| {
                let Some(lock) = state::read_index_lock(&git_dir) else {
                    return Ok(());
                };
                if !lock.stale {
                    return Err(YagguiError::index_locked(Some(repo_id), &lock.path));
                }
                std::fs::remove_file(&lock.path)
                    .map_err(|err| BackendError::io(format!("cannot remove {}", lock.path), err))?;
                tracing::info!(repo_id, path = %lock.path, "removed stale index.lock");
                Ok(())
            })
    }

    /// Adds `path` to the global `safe.directory` list. Only after explicit user consent.
    pub fn add_safe_directory(&self, path: &str) -> Result<(), YagguiError> {
        if path.trim().is_empty() || !Path::new(path).is_absolute() {
            return Err(YagguiError::invalid_argument(
                format!("Expected an absolute folder path, got \"{path}\"."),
                format!("Chemin de dossier absolu attendu, reçu « {path} »."),
            ));
        }
        self.git
            .run(&GitCommand::new(["config", "--global", "--add", "safe.directory"]).arg(path))?;
        Ok(())
    }

    /// Git refuses repositories owned by another user unless listed in `safe.directory`.
    /// `gix` opens them with reduced trust instead, so ask `git` itself — only in that case,
    /// as it costs a process spawn.
    fn check_safe_directory(
        &self,
        repo: &gix::ThreadSafeRepository,
        workdir: &Path,
    ) -> Result<(), YagguiError> {
        let trust = gix::sec::Trust::from_path_ownership(repo.git_dir())
            .unwrap_or(gix::sec::Trust::Reduced);
        if trust == gix::sec::Trust::Full {
            return Ok(());
        }
        match self
            .git
            .run(&GitCommand::new(["rev-parse", "--git-dir"]).cwd(workdir))
        {
            Err(err) if err.code == ErrorCode::UnsafeRepository => Err(err),
            _ => Ok(()),
        }
    }
}

/// Clears `commit_graph_queued` when dropped while still holding the session.
struct RetryCommitGraph(Option<Weak<RepoSession>>);

impl RetryCommitGraph {
    /// The write ran to its end (succeeded or failed for good): no retry. A method, so the
    /// job closure captures the whole guard (not just a field) and drops it with the job.
    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for RetryCommitGraph {
    fn drop(&mut self) {
        if let Some(session) = self.0.take().and_then(|weak| weak.upgrade()) {
            session.commit_graph_queued.store(false, Ordering::SeqCst);
        }
    }
}

// Poisoning only means another thread panicked while holding the guard; the data
// (a gix handle, a map of sessions) stays valid.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn read<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(PoisonError::into_inner)
}

fn write<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(PoisonError::into_inner)
}

fn config_stamp(files: &[PathBuf]) -> ConfigStamp {
    files
        .iter()
        .map(|file| {
            let metadata = std::fs::metadata(file).ok()?;
            Some((metadata.modified().ok()?, metadata.len()))
        })
        .collect()
}

/// Canonical form used as the persisted identity of a repo, so `/a/../a/repo` and
/// symlinks resolve to the same entry.
fn normalize(path: &Path) -> PathBuf {
    crate::system::paths::canonical(path)
}

/// Path shown to the user. On Windows `canonicalize` adds a `\\?\` prefix that most
/// tools (and Git) do not expect.
fn display_path(path: &Path) -> String {
    let text = path.display().to_string();
    if cfg!(windows)
        && let Some(stripped) = text.strip_prefix(r"\\?\")
        && !stripped.starts_with("UNC\\")
    {
        return stripped.to_owned();
    }
    text
}

// Graph and refs reads (M1-1), implemented in `graph/` and `git/read/refs.rs`.
impl RepoManager {
    pub fn graph_page(
        &self,
        repo_id: u32,
        start: u32,
        limit: u32,
    ) -> Result<GraphPage, YagguiError> {
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        let (page, snapshot) = session.read_graph(&repo, |snapshot| {
            Ok((
                graph::page(&repo, snapshot, start, limit)?,
                Arc::clone(snapshot),
            ))
        })?;
        self.maybe_write_commit_graph(&session, &repo, &snapshot);
        Ok(page)
    }

    /// Queues a background commit-graph write when the file is missing or far behind, so
    /// the next loads are fast. Checked after a page is served: it never delays the graph.
    fn maybe_write_commit_graph(
        &self,
        session: &Arc<RepoSession>,
        repo: &gix::Repository,
        snapshot: &graph::Snapshot,
    ) {
        // Without the file, every commit decoded so far is missing from it: enough to decide
        // before the walk is done.
        let missing = snapshot.outside_graph();
        if session.commit_graph_queued.load(Ordering::SeqCst)
            || !commit_graph::is_worth_writing(repo, missing)
            || session.commit_graph_queued.swap(true, Ordering::SeqCst)
        {
            return;
        }
        let git = Arc::clone(&self.git);
        let workdir = session.workdir.clone();
        let objects_dir = repo.objects.store_ref().path().to_path_buf();
        let repo_id = session.id;
        // Allows another attempt (on a later graph load) unless the write ran to its end:
        // also when the job is dropped unrun (cancelled while queued, queue shut down).
        let mut retry = RetryCommitGraph(Some(Arc::downgrade(session)));
        tracing::info!(repo_id, missing, "queuing a commit-graph write");
        let queued = session
            .queue
            .enqueue_background(OpKind::CommitGraph, move |ctx| {
                let result = commit_graph::write(&git, &workdir, &objects_dir, repo_id, ctx.cancel);
                match &result {
                    Err(err) if err.code == ErrorCode::Cancelled => {}
                    Err(err) => {
                        tracing::warn!(repo_id, error = %err, "commit-graph write failed");
                        retry.disarm();
                    }
                    // The graph is rebuilt on the new file by the next page request (the
                    // store notices the file changed); `op-finished` makes the UI ask for it.
                    Ok(()) => retry.disarm(),
                }
                result
            });
        if let Err(err) = queued {
            tracing::warn!(repo_id, error = %err, "cannot queue the commit-graph write");
        }
    }

    pub fn graph_index_of(&self, repo_id: u32, rev: &str) -> Result<GraphLocation, YagguiError> {
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        session.read_graph(&repo, |snapshot| graph::index_of(&repo, snapshot, rev))
    }

    pub fn search_commits(
        &self,
        repo_id: u32,
        query: &CommitSearch,
        from_row: u32,
    ) -> Result<SearchChunk, YagguiError> {
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        session.read_graph(&repo, |snapshot| {
            graph::search::search(
                &repo,
                snapshot,
                query,
                from_row,
                graph::search::SEARCH_BUDGET,
            )
        })
    }

    pub fn commit_detail(&self, repo_id: u32, sha: &str) -> Result<CommitDetail, YagguiError> {
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        let snapshot = session.snapshot(&repo)?;
        graph::commit_detail(&repo, &snapshot, sha)
    }

    /// Refs for the sidebar. Rows are filled only when the graph of these refs is already
    /// computed: listing refs never waits for a full history walk.
    pub fn list_refs(&self, repo_id: u32) -> Result<RepoRefs, YagguiError> {
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        let fingerprint = session.fingerprint(&repo)?;
        let mut refs = refs::read_refs(&repo, &mut lock(&session.refs_cache))?;
        if let Some(snapshot) = session.graph.current(fingerprint) {
            let row = |sha: &str| {
                gix::ObjectId::from_hex(sha.as_bytes())
                    .ok()
                    .and_then(|id| snapshot.row_of(&id))
            };
            refs.graph_version = Some(snapshot.version);
            for branch in &mut refs.local {
                branch.row = row(&branch.sha);
            }
            for branch in refs.remotes.iter_mut().flat_map(|r| r.branches.iter_mut()) {
                branch.row = row(&branch.sha);
            }
            for tag in &mut refs.tags {
                tag.row = row(&tag.sha);
            }
            for stash in &mut refs.stashes {
                stash.row = row(&stash.base_sha);
            }
        }
        Ok(refs)
    }
}
