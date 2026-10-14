//! Filesystem watcher: turns worktree and `.git` changes into debounced
//! `status-changed` / `refs-changed` events.

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use gix::bstr::ByteSlice;
use notify::event::{CreateKind, ModifyKind, RenameMode};
use notify::{EventKind, RecursiveMode, Watcher as _, WatcherKind};

use crate::events::{BackendEvent, EventSink, RefsChanged, StatusChanged};
use crate::git::errors::{BackendError, YagguiError};

/// Quiet period before a batch of changes is reported. Short: it is most of the P-05 budget
/// (status refreshed < 200 ms after a save), and an editor's save (write, or write + rename)
/// takes a few milliseconds.
pub const DEBOUNCE: Duration = Duration::from_millis(40);
/// Minimum time between two reports: a stream of changes (a build, a checkout) refreshes the
/// status a few times per second, not after every quiet period.
const MIN_INTERVAL: Duration = Duration::from_millis(300);
/// Upper bound on the delay under a continuous stream of changes (e.g. a build).
const MAX_DELAY: Duration = Duration::from_secs(1);

/// What a filesystem change may have affected.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Impact {
    pub status: bool,
    pub refs: bool,
    /// A config file changed: the session must reload its gix handle.
    pub config: bool,
}

impl Impact {
    fn any(self) -> bool {
        self.status || self.refs || self.config
    }

    fn merge(&mut self, other: Impact) {
        self.status |= other.status;
        self.refs |= other.refs;
        self.config |= other.config;
    }
}

/// Raw notification forwarded to the debounce thread.
enum Change {
    /// Classified change inside the git dir.
    GitDir(Impact),
    /// Worktree path (absolute), checked against ignore rules before reporting.
    Worktree(PathBuf),
    /// A directory appeared: in per-directory mode, it must be watched too.
    NewDir(PathBuf),
}

/// Watches one repository while alive.
pub struct Watcher {
    _inner: Arc<Mutex<notify::RecommendedWatcher>>,
    watched_dirs: Arc<AtomicUsize>,
    incomplete: Arc<AtomicBool>,
}

/// inotify (and kqueue) watch one directory per watch, and a recursive watch includes ignored
/// trees (`node_modules/`, `target/`: thousands of folders, against a per-user limit). With
/// them, folders are watched one by one, skipping ignored ones and Git internals.
fn per_directory() -> bool {
    matches!(
        notify::RecommendedWatcher::kind(),
        WatcherKind::Inotify | WatcherKind::Kqueue
    )
}

/// Folders of the git dir that never hold anything the watcher reports.
const GIT_DIR_SKIPPED: &[&str] = &["objects", "logs", "hooks", "lfs", "modules", "worktrees"];

impl Watcher {
    /// `repo` is used to filter out changes to ignored files (`target/`, `node_modules/`…).
    /// `config_changed` is raised when a config file changes, so the session reloads it.
    /// `status_generation` is bumped as soon as a change that may affect the status arrives,
    /// before the debounce (ignored files included: checking them costs more than a status).
    pub fn start(
        repo_id: u32,
        repo: gix::ThreadSafeRepository,
        sink: Arc<dyn EventSink>,
        config_changed: Arc<AtomicBool>,
        refs_changed: Arc<AtomicBool>,
        status_generation: Arc<AtomicU64>,
    ) -> Result<Self, YagguiError> {
        let dirs = Dirs {
            git_dir: canonical(repo.git_dir()),
            common_dir: canonical(repo.to_thread_local().common_dir()),
            workdir: repo.work_dir().map(canonical),
        };
        let (tx, rx) = mpsc::channel::<Change>();

        let started = Instant::now();
        let per_directory = per_directory();
        let handler_dirs = dirs.clone();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            // Events may have been lost (queue overflow, error): assume everything changed.
            let lost = Change::GitDir(Impact {
                status: true,
                refs: true,
                config: false,
            });
            let event = match res {
                Ok(event) => event,
                Err(err) => {
                    tracing::warn!(error = %err, "watcher error");
                    status_generation.fetch_add(1, Ordering::SeqCst);
                    let _ = tx.send(lost);
                    return;
                }
            };
            if event.need_rescan() {
                tracing::warn!("watcher dropped events; refreshing everything");
                status_generation.fetch_add(1, Ordering::SeqCst);
                let _ = tx.send(lost);
            }
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            // Created, or moved in / renamed: a folder to watch.
            let created_dir = per_directory
                && matches!(
                    event.kind,
                    EventKind::Create(CreateKind::Folder | CreateKind::Any)
                        | EventKind::Modify(ModifyKind::Name(
                            RenameMode::To | RenameMode::Both | RenameMode::Any
                        ))
                );
            for path in event.paths {
                // The receiver is gone only when the watcher is being dropped.
                if created_dir && path.is_dir() {
                    let _ = tx.send(Change::NewDir(path.clone()));
                }
                if let Some(change) = route(&path, &handler_dirs) {
                    if matches!(
                        change,
                        Change::Worktree(_) | Change::GitDir(Impact { status: true, .. })
                    ) {
                        status_generation.fetch_add(1, Ordering::SeqCst);
                    }
                    let _ = tx.send(change);
                }
            }
        })
        .map_err(BackendError::from)?;
        let watcher = Arc::new(Mutex::new(watcher));
        let watched_dirs = Arc::new(AtomicUsize::new(0));

        let incomplete = Arc::new(AtomicBool::new(false));
        // Git dirs first, on their own: if the watch limit is reached, it is in the worktree.
        let git_roots = nested_roots([&dirs.git_dir, &dirs.common_dir]);
        let tree = WatchTree {
            watcher: Arc::downgrade(&watcher),
            repo: repo.clone(),
            dirs: dirs.clone(),
            git_roots: git_roots.clone(),
            count: Arc::clone(&watched_dirs),
            incomplete: Arc::clone(&incomplete),
        };
        if per_directory {
            for root in git_roots.iter().chain(dirs.workdir.as_ref()) {
                tree.add(root)?;
            }
        }
        if !per_directory {
            for root in dirs.roots() {
                lock(&watcher)
                    .watch(&root, RecursiveMode::Recursive)
                    .map_err(BackendError::from)?;
                watched_dirs.fetch_add(1, Ordering::Relaxed);
            }
        }
        tracing::info!(
            repo_id,
            per_directory,
            watches = watched_dirs.load(Ordering::Relaxed),
            ms = started.elapsed().as_millis() as u64,
            "watcher started"
        );

        thread::Builder::new()
            .name(format!("yaggui-watch-{repo_id}"))
            .spawn(move || {
                let workdir = dirs.workdir.as_deref();
                debounce_loop(
                    repo_id,
                    &repo,
                    workdir,
                    &rx,
                    sink.as_ref(),
                    Raised {
                        config: &config_changed,
                        refs: &refs_changed,
                    },
                    &tree,
                );
            })
            .map_err(|e| {
                YagguiError::watch_unavailable(
                    BackendError::io("cannot start the watcher thread", e).chain(),
                )
            })?;

        Ok(Self {
            _inner: watcher,
            watched_dirs,
            incomplete,
        })
    }

    /// `false` when some folders could not be watched (watch limit reached): changes there
    /// may go unreported, so nothing should be cached on the watcher's word.
    pub fn is_complete(&self) -> bool {
        !self.incomplete.load(Ordering::Relaxed)
    }

    /// Number of watches registered (folders in per-directory mode, roots otherwise).
    pub fn watched_dirs(&self) -> usize {
        self.watched_dirs.load(Ordering::Relaxed)
    }
}

/// Adds per-directory watches on a tree, skipping what never matters to the watcher.
struct WatchTree {
    /// Weak: the debounce thread must not keep the watcher (and its channel) alive.
    watcher: Weak<Mutex<notify::RecommendedWatcher>>,
    repo: gix::ThreadSafeRepository,
    dirs: Dirs,
    /// Watched on their own before the worktree: skipped when met inside it.
    git_roots: Vec<PathBuf>,
    count: Arc<AtomicUsize>,
    /// Raised when a folder could not be watched for another reason than being gone.
    incomplete: Arc<AtomicBool>,
}

impl WatchTree {
    /// Watches `root` and its folders. Errors only for `root` itself: a sub-folder removed
    /// meanwhile, or unreadable, is skipped.
    fn add(&self, root: &Path) -> Result<(), YagguiError> {
        let Some(watcher) = self.watcher.upgrade() else {
            return Ok(());
        };
        let repo = self.repo.to_thread_local();
        let index = repo.index_or_empty().ok();
        let mut excludes = index.as_ref().and_then(|index| {
            repo.excludes(
                index,
                None,
                gix::worktree::stack::state::ignore::Source::WorktreeThenIdMappingIfNotSkipped,
            )
            .ok()
        });
        let mut watcher = lock(&watcher);
        let mut stack = vec![root.to_path_buf()];
        let mut first = true;
        while let Some(dir) = stack.pop() {
            match watcher.watch(&dir, RecursiveMode::NonRecursive) {
                Ok(()) => {
                    self.count.fetch_add(1, Ordering::Relaxed);
                }
                Err(err) if first => return Err(BackendError::from(err).into()),
                Err(err) => {
                    let gone = matches!(err.kind, notify::ErrorKind::PathNotFound)
                        || matches!(&err.kind, notify::ErrorKind::Io(io) if io.kind() == std::io::ErrorKind::NotFound);
                    if gone {
                        tracing::debug!(dir = %dir.display(), error = %err, "folder gone");
                    } else if !self.incomplete.swap(true, Ordering::Relaxed) {
                        tracing::warn!(dir = %dir.display(), error = %err, "folder not watched");
                    }
                    continue;
                }
            }
            first = false;
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                // Symlinks are not followed (`file_type` does not resolve them).
                if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                    continue;
                }
                let path = entry.path();
                if !self.skipped(
                    &path,
                    index.as_deref().map(|snapshot| &**snapshot),
                    excludes.as_mut(),
                ) {
                    stack.push(path);
                }
            }
        }
        Ok(())
    }

    /// Watches a folder created after the start, unless it is one to skip.
    fn add_new(&self, path: &Path) -> Result<(), YagguiError> {
        let repo = self.repo.to_thread_local();
        let index = repo.index_or_empty().ok();
        let mut excludes = index.as_ref().and_then(|index| {
            repo.excludes(
                index,
                None,
                gix::worktree::stack::state::ignore::Source::WorktreeThenIdMappingIfNotSkipped,
            )
            .ok()
        });
        if self.skipped(
            path,
            index.as_deref().map(|snapshot| &**snapshot),
            excludes.as_mut(),
        ) {
            return Ok(());
        }
        self.add(path)
    }

    fn skipped(
        &self,
        path: &Path,
        index: Option<&gix::index::File>,
        excludes: Option<&mut gix::AttributeStack<'_>>,
    ) -> bool {
        if self.git_roots.iter().any(|root| root == path) {
            return true;
        }
        // A linked worktree's git dir lives in `<common dir>/worktrees/<name>`.
        if self.dirs.git_dir.starts_with(path) {
            return false;
        }
        for git_dir in [&self.dirs.git_dir, &self.dirs.common_dir] {
            if let Ok(relative) = path.strip_prefix(git_dir) {
                return relative.components().next().is_some_and(
                    |c| matches!(c, Component::Normal(name) if GIT_DIR_SKIPPED.iter().any(|s| name == *s)),
                );
            }
        }
        let Some(relative) = self
            .dirs
            .workdir
            .as_deref()
            .and_then(|workdir| path.strip_prefix(workdir).ok())
        else {
            return false;
        };
        // Nested repositories (`.git` folders) are not worktree content; ours is handled above.
        if path.file_name().is_some_and(|name| name == ".git") {
            return true;
        }
        let (Some(index), Some(excludes)) = (index, excludes) else {
            return false;
        };
        let excluded = excludes
            .at_path(relative, Some(gix::index::entry::Mode::DIR))
            .is_ok_and(|platform| platform.is_excluded());
        // An ignored folder can still hold tracked (force-added) files.
        excluded && !has_tracked_files(index, relative)
    }
}

fn has_tracked_files(index: &gix::index::State, relative: &Path) -> bool {
    let Some(text) = relative.to_str() else {
        return true;
    };
    let prefix = format!("{}/", text.replace('\\', "/"));
    index
        .prefixed_entries(prefix.as_bytes().as_bstr())
        .is_some_and(|entries| !entries.is_empty())
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Folders of a repository, canonicalized like the paths notify reports.
#[derive(Debug, Clone)]
struct Dirs {
    git_dir: PathBuf,
    /// Shared refs, objects and config. Differs from `git_dir` for linked worktrees.
    common_dir: PathBuf,
    workdir: Option<PathBuf>,
}

impl Dirs {
    /// Folders to watch recursively, without nesting duplicates.
    fn roots(&self) -> Vec<PathBuf> {
        nested_roots(self.workdir.iter().chain([&self.git_dir, &self.common_dir]))
    }
}

/// The folders not inside another one of the list.
fn nested_roots<'a>(candidates: impl IntoIterator<Item = &'a PathBuf>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for dir in candidates {
        if !roots.iter().any(|root| dir.starts_with(root)) {
            roots.retain(|root| !root.starts_with(dir));
            roots.push(dir.clone());
        }
    }
    roots
}

fn canonical(path: &Path) -> PathBuf {
    // macOS reports canonical paths (`/private/var/...`): compare against the same form.
    crate::system::paths::canonical(path)
}

fn route(path: &Path, dirs: &Dirs) -> Option<Change> {
    if let Ok(relative) = path.strip_prefix(&dirs.git_dir) {
        let impact = classify_git_path(relative);
        return impact.any().then_some(Change::GitDir(impact));
    }
    if dirs.common_dir != dirs.git_dir
        && let Ok(relative) = path.strip_prefix(&dirs.common_dir)
    {
        let impact = classify_common_path(relative);
        return impact.any().then_some(Change::GitDir(impact));
    }
    let workdir = dirs.workdir.as_deref()?;
    let relative = path.strip_prefix(workdir).ok()?;
    // A `.git` *file* (submodule, linked worktree) or another nested `.git`: never worktree content.
    if relative
        .components()
        .any(|c| matches!(c, Component::Normal(name) if name == ".git"))
    {
        return None;
    }
    Some(Change::Worktree(path.to_path_buf()))
}

/// Classifies a path relative to the git dir. Everything not listed (objects, logs, hooks,
/// `*.lock` temporaries, `FETCH_HEAD`…) is internal noise.
pub fn classify_git_path(relative: &Path) -> Impact {
    let none = Impact::default();
    let Some(Component::Normal(first)) = relative.components().next() else {
        return none;
    };
    let first = first.to_string_lossy();
    let is_lock = relative
        .extension()
        .is_some_and(|extension| extension == "lock");
    if is_lock {
        return none;
    }
    let status = Impact {
        status: true,
        ..none
    };
    match first.as_ref() {
        "HEAD" => Impact {
            status: true,
            refs: true,
            config: false,
        },
        // A local branch that moves may be the checked out one (commit, reset, end of a
        // rebase): `HEAD` itself does not change, the index not always, but the status
        // (HEAD against the index) does. A fetch only touches `refs/remotes`.
        "refs" if relative.starts_with("refs/heads") => Impact {
            status: true,
            refs: true,
            config: false,
        },
        "refs" | "packed-refs" => Impact { refs: true, ..none },
        // Upstreams, remotes and other settings shown with the refs live in the config.
        "config" | "config.worktree" => Impact {
            refs: true,
            config: true,
            ..none
        },
        "index" | "rebase-merge" | "rebase-apply" | "sequencer" | "BISECT_LOG" | "SQUASH_MSG" => {
            status
        }
        "FETCH_HEAD" => none,
        name if name.ends_with("_HEAD") => status,
        _ => none,
    }
}

/// Classifies a path relative to the common dir of a linked worktree: only what is shared
/// (refs, config) matters; the main worktree's HEAD and index are another worktree's state.
pub fn classify_common_path(relative: &Path) -> Impact {
    let impact = classify_git_path(relative);
    Impact {
        status: false,
        ..impact
    }
    .shared_only(relative)
}

impl Impact {
    fn shared_only(self, relative: &Path) -> Impact {
        let first = relative.components().next();
        let shared = matches!(
            first,
            Some(Component::Normal(name)) if name == "refs" || name == "packed-refs" || name == "config"
        );
        if shared { self } else { Impact::default() }
    }
}

/// Flags the session reads before its next access: config to reload, refs to read again.
struct Raised<'a> {
    config: &'a AtomicBool,
    refs: &'a AtomicBool,
}

fn debounce_loop(
    repo_id: u32,
    repo: &gix::ThreadSafeRepository,
    workdir: Option<&Path>,
    rx: &mpsc::Receiver<Change>,
    sink: &dyn EventSink,
    raised: Raised<'_>,
    tree: &WatchTree,
) {
    // The first change after a calm period is reported after `DEBOUNCE`; later ones wait
    // until `MIN_INTERVAL` after the previous report.
    let mut last_report: Option<Instant> = None;
    loop {
        let Ok(first) = rx.recv() else {
            return;
        };
        let started = Instant::now();
        let mut impact = Impact::default();
        let mut worktree_paths = Vec::new();
        let mut collect = |change: Change| match change {
            Change::GitDir(i) => impact.merge(i),
            Change::Worktree(path) => worktree_paths.push(path),
            Change::NewDir(path) => {
                // Files created in it before the watch exists are covered by the status
                // refresh that the folder creation itself triggers.
                if let Err(err) = tree.add_new(&path) {
                    tracing::debug!(dir = %path.display(), error = %err, "new folder not watched");
                }
            }
        };
        collect(first);
        let not_before = last_report.map(|at| at + MIN_INTERVAL);
        let mut disconnected = false;
        while started.elapsed() < MAX_DELAY {
            // Quiet for `DEBOUNCE`, and not before `not_before`.
            let wait = not_before
                .map(|at| at.saturating_duration_since(Instant::now()))
                .filter(|left| *left > DEBOUNCE)
                .unwrap_or(DEBOUNCE)
                .min(MAX_DELAY.saturating_sub(started.elapsed()));
            match rx.recv_timeout(wait) {
                Ok(change) => collect(change),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if not_before.is_none_or(|at| Instant::now() >= at) {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    disconnected = true;
                    break;
                }
            }
        }

        if !impact.status
            && let Some(workdir) = workdir
            && !worktree_paths.is_empty()
        {
            impact.status = any_not_ignored(repo, workdir, &worktree_paths);
        }
        if impact.config {
            // Before the events, so the refetch they trigger sees the new config.
            raised.config.store(true, Ordering::SeqCst);
        }
        if impact.any() {
            last_report = Some(Instant::now());
        }
        if impact.status {
            sink.emit(BackendEvent::StatusChanged(StatusChanged { repo_id }));
        }
        if impact.refs {
            raised.refs.store(true, Ordering::SeqCst);
            sink.emit(BackendEvent::RefsChanged(RefsChanged { repo_id }));
        }
        if disconnected {
            return;
        }
    }
}

/// `true` if at least one path is tracked or not excluded by `.gitignore` rules (or if the
/// rules can't be read). A tracked file stays relevant even when a pattern matches it.
fn any_not_ignored(repo: &gix::ThreadSafeRepository, workdir: &Path, paths: &[PathBuf]) -> bool {
    let repo = repo.to_thread_local();
    let check = || -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let index = repo.index_or_empty()?;
        let mut stack = repo.excludes(
            &index,
            None,
            gix::worktree::stack::state::ignore::Source::WorktreeThenIdMappingIfNotSkipped,
        )?;
        for path in paths {
            let Ok(relative) = path.strip_prefix(workdir) else {
                continue;
            };
            if is_tracked(&index, relative) || !is_excluded(&mut stack, relative, path.is_dir())? {
                return Ok(true);
            }
        }
        Ok(false)
    };
    check().unwrap_or_else(|err| {
        tracing::debug!(error = %err, "ignore check failed; reporting the change");
        true
    })
}

fn is_tracked(index: &gix::index::State, relative: &Path) -> bool {
    let Some(text) = relative.to_str() else {
        // Non-UTF-8 path: let the status refresh decide.
        return true;
    };
    // The index uses `/` separators on every platform.
    let key = text.replace('\\', "/");
    index.entry_by_path(key.as_str().into()).is_some()
}

/// Git ignores a file if it or any parent directory matches an exclude pattern.
fn is_excluded(
    stack: &mut gix::AttributeStack<'_>,
    relative: &Path,
    is_dir: bool,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let components: Vec<_> = relative.components().collect();
    let mut prefix = PathBuf::new();
    for (index, component) in components.iter().enumerate() {
        prefix.push(component);
        let leaf = index + 1 == components.len();
        let mode = (!leaf || is_dir).then_some(gix::index::entry::Mode::DIR);
        if stack.at_path(&prefix, mode)?.is_excluded() {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn impact(path: &str) -> Impact {
        classify_git_path(Path::new(path))
    }

    #[test]
    fn classifies_refs_and_head() {
        assert_eq!(
            impact("HEAD"),
            Impact {
                status: true,
                refs: true,
                config: false,
            }
        );
        let branch = impact("refs/heads/main");
        assert!(
            branch.refs && branch.status,
            "a commit moves the checked out branch"
        );
        let remote = impact("refs/remotes/origin/main");
        assert!(
            remote.refs && !remote.status,
            "a fetch leaves the status alone"
        );
        assert!(impact("packed-refs").refs);
    }

    #[test]
    fn classifies_status_files() {
        for path in [
            "index",
            "MERGE_HEAD",
            "CHERRY_PICK_HEAD",
            "rebase-merge/msgnum",
            "sequencer/todo",
            "SQUASH_MSG",
        ] {
            let i = impact(path);
            assert!(i.status && !i.refs, "{path}");
        }
    }

    #[test]
    fn ignores_internal_noise() {
        for path in [
            "objects/ab/cdef",
            "logs/HEAD",
            "index.lock",
            "HEAD.lock",
            "refs/heads/main.lock",
            "FETCH_HEAD",
            "hooks/pre-commit",
            "COMMIT_EDITMSG",
        ] {
            assert!(!impact(path).any(), "{path}");
        }
    }

    #[test]
    fn config_changes_reload_and_refresh_refs() {
        let i = impact("config");
        assert!(i.config && i.refs && !i.status);
        assert!(impact("config.worktree").config);
        assert!(!impact("config.lock").any());
    }

    #[test]
    fn linked_worktrees_only_care_about_shared_files() {
        let common = |p: &str| classify_common_path(Path::new(p));
        assert!(common("refs/heads/main").refs);
        assert!(common("packed-refs").refs);
        assert!(common("config").config);
        for path in [
            "HEAD",
            "index",
            "MERGE_HEAD",
            "worktrees/wt/HEAD",
            "objects/ab/cd",
        ] {
            assert!(!common(path).any(), "{path}");
        }
    }

    fn dirs() -> Dirs {
        Dirs {
            git_dir: "/r/.git".into(),
            common_dir: "/r/.git".into(),
            workdir: Some("/r".into()),
        }
    }

    #[test]
    fn routes_paths() {
        let dirs = dirs();
        assert!(matches!(
            route(Path::new("/r/.git/index"), &dirs),
            Some(Change::GitDir(_))
        ));
        assert!(route(Path::new("/r/.git/objects/x"), &dirs).is_none());
        assert!(matches!(
            route(Path::new("/r/src/main.rs"), &dirs),
            Some(Change::Worktree(_))
        ));
        assert!(route(Path::new("/r/sub/.git"), &dirs).is_none());
        assert!(route(Path::new("/elsewhere/file"), &dirs).is_none());
    }

    #[test]
    fn routes_linked_worktree_paths() {
        let dirs = Dirs {
            git_dir: "/main/.git/worktrees/wt".into(),
            common_dir: "/main/.git".into(),
            workdir: Some("/wt".into()),
        };
        assert!(matches!(
            route(Path::new("/main/.git/refs/heads/topic"), &dirs),
            Some(Change::GitDir(Impact { refs: true, .. }))
        ));
        assert!(matches!(
            route(Path::new("/main/.git/worktrees/wt/HEAD"), &dirs),
            Some(Change::GitDir(Impact {
                status: true,
                refs: true,
                ..
            }))
        ));
        assert!(route(Path::new("/main/.git/index"), &dirs).is_none());
        assert_eq!(
            dirs.roots(),
            [PathBuf::from("/wt"), PathBuf::from("/main/.git")]
        );
        assert_eq!(super::tests::dirs().roots(), [PathBuf::from("/r")]);
    }
}
