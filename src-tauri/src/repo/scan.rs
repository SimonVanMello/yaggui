//! Discovery of the repositories under a parent folder (F-007). Pure file system walk: no Git
//! process, nothing written. A scan is identified by an id chosen by the frontend, so it can be
//! cancelled before the command has returned.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::events::{BackendEvent, EventSink, ScanProgress};
use crate::git::cli::CancelToken;
use crate::git::errors::YagguiError;
use crate::store::Store;

use super::{display_path, normalize};

/// Accepted depths: 1 lists the direct subfolders of the root.
pub const SCAN_DEPTH_RANGE: std::ops::RangeInclusive<u32> = 1..=8;
/// Repositories listed at most; the scan stops there (`truncated`).
pub const SCAN_MAX_RESULTS: usize = 2000;
/// Folders never entered: Git internals and dependency trees (huge, never worth a look).
const SKIPPED: [&str; 2] = [".git", "node_modules"];
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScanRequest {
    /// Chosen by the frontend; tags `scan-progress` events and targets `cancel_scan`.
    pub scan_id: String,
    /// Absolute path of the folder to explore.
    pub root: String,
    /// How many folder levels below the root are explored, within `SCAN_DEPTH_RANGE`.
    pub max_depth: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScannedRepo {
    /// Worktree root, as `open_repo` would store it.
    pub path: String,
    pub name: String,
    /// Id of the known repo at this path, if it is already in the list.
    pub known_id: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    /// Sorted by path.
    pub repos: Vec<ScannedRepo>,
    /// Folders explored.
    pub visited: u32,
    /// The scan stopped at `SCAN_MAX_RESULTS` repositories.
    pub truncated: bool,
}

pub struct RepoScanner {
    store: Arc<Store>,
    sink: Arc<dyn EventSink>,
    running: Mutex<HashMap<String, CancelToken>>,
}

impl RepoScanner {
    pub fn new(store: Arc<Store>, sink: Arc<dyn EventSink>) -> Self {
        Self {
            store,
            sink,
            running: Mutex::default(),
        }
    }

    /// Requests the cancellation of a running scan. Nothing happens if it already finished.
    pub fn cancel(&self, scan_id: &str) {
        if let Some(token) = self.lock_running().get(scan_id) {
            token.cancel();
        }
    }

    /// Walks `root` breadth first. A repository is listed and not entered (its submodules and
    /// nested repos belong to it); symbolic links are not followed, so a loop cannot trap the
    /// scan. Unreadable folders are skipped.
    pub fn scan(&self, request: &ScanRequest) -> Result<ScanResult, YagguiError> {
        let root = Path::new(&request.root);
        if request.root.trim().is_empty() || !root.is_absolute() {
            return Err(YagguiError::invalid_argument(
                format!(
                    "Expected an absolute folder path, got \"{}\".",
                    request.root
                ),
                format!(
                    "Chemin de dossier absolu attendu, reçu « {} ».",
                    request.root
                ),
            ));
        }
        if !root.is_dir() {
            return Err(YagguiError::repo_not_found(&request.root));
        }
        if !SCAN_DEPTH_RANGE.contains(&request.max_depth) {
            return Err(YagguiError::invalid_argument(
                format!(
                    "The depth must be between {} and {}.",
                    SCAN_DEPTH_RANGE.start(),
                    SCAN_DEPTH_RANGE.end()
                ),
                format!(
                    "La profondeur doit être comprise entre {} et {}.",
                    SCAN_DEPTH_RANGE.start(),
                    SCAN_DEPTH_RANGE.end()
                ),
            ));
        }
        let token = CancelToken::new();
        {
            let mut running = self.lock_running();
            if request.scan_id.is_empty() || running.contains_key(&request.scan_id) {
                return Err(YagguiError::invalid_argument(
                    "This scan is already running.",
                    "Ce scan est déjà en cours.",
                ));
            }
            running.insert(request.scan_id.clone(), token.clone());
        }
        let result = self.walk(request, &normalize(root), &token);
        self.lock_running().remove(&request.scan_id);
        let mut result = result?;
        let known = self.store.repo_ids_by_path()?;
        for repo in &mut result.repos {
            repo.known_id = known.get(&repo.path).copied();
        }
        Ok(result)
    }

    fn walk(
        &self,
        request: &ScanRequest,
        root: &Path,
        token: &CancelToken,
    ) -> Result<ScanResult, YagguiError> {
        let mut queue = VecDeque::from([(root.to_path_buf(), 0_u32)]);
        let mut repos = Vec::new();
        let mut visited = 0_u32;
        let mut truncated = false;
        let mut last_report: Option<Instant> = None;
        while let Some((dir, depth)) = queue.pop_front() {
            if token.is_cancelled() {
                return Err(YagguiError::cancelled());
            }
            visited = visited.saturating_add(1);
            if last_report.is_none_or(|at| at.elapsed() >= PROGRESS_EVERY) {
                last_report = Some(Instant::now());
                self.report(request, visited, repos.len(), &dir);
            }
            if is_worktree_root(&dir) {
                let shown = display_path(&dir);
                let name = dir
                    .file_name()
                    .map_or_else(|| shown.clone(), |n| n.to_string_lossy().into_owned());
                repos.push(ScannedRepo {
                    path: shown,
                    name,
                    known_id: None,
                });
                if repos.len() >= SCAN_MAX_RESULTS {
                    truncated = true;
                    break;
                }
                continue;
            }
            if depth >= request.max_depth {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut children: Vec<PathBuf> = entries
                .filter_map(Result::ok)
                .filter(|entry| {
                    // `file_type` does not follow symbolic links.
                    entry.file_type().is_ok_and(|t| t.is_dir())
                        && !SKIPPED.iter().any(|skipped| entry.file_name() == *skipped)
                })
                .map(|entry| entry.path())
                .collect();
            children.sort();
            queue.extend(children.into_iter().map(|child| (child, depth + 1)));
        }
        self.report(request, visited, repos.len(), root);
        repos.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(ScanResult {
            repos,
            visited,
            truncated,
        })
    }

    fn report(&self, request: &ScanRequest, visited: u32, found: usize, dir: &Path) {
        self.sink.emit(BackendEvent::ScanProgress(ScanProgress {
            scan_id: request.scan_id.clone(),
            visited,
            found: u32::try_from(found).unwrap_or(u32::MAX),
            current: display_path(dir),
        }));
    }

    fn lock_running(&self) -> std::sync::MutexGuard<'_, HashMap<String, CancelToken>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A `.git` folder with a `HEAD`, or a `.git` file pointing elsewhere (linked worktree,
/// submodule checked out on its own). Bare repositories are not listed: yaggui cannot open them.
fn is_worktree_root(dir: &Path) -> bool {
    let dot_git = dir.join(".git");
    match std::fs::symlink_metadata(&dot_git) {
        Ok(meta) if meta.is_dir() => dot_git.join("HEAD").is_file(),
        Ok(meta) if meta.is_file() => std::fs::read_to_string(&dot_git)
            .is_ok_and(|content| content.trim_start().starts_with("gitdir:")),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::NullSink;

    fn scanner() -> RepoScanner {
        RepoScanner::new(
            Arc::new(Store::open_in_memory().unwrap()),
            Arc::new(NullSink),
        )
    }

    fn fake_repo(dir: &Path) {
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    }

    fn request(root: &Path, max_depth: u32) -> ScanRequest {
        ScanRequest {
            scan_id: "s".into(),
            root: root.to_string_lossy().into_owned(),
            max_depth,
        }
    }

    fn names(result: &ScanResult) -> Vec<&str> {
        result.repos.iter().map(|r| r.name.as_str()).collect()
    }

    #[test]
    fn finds_repos_down_to_the_depth_and_skips_ignored_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fake_repo(&root.join("a"));
        fake_repo(&root.join("group/b"));
        fake_repo(&root.join("group/deep/c"));
        // Nested inside a repo, under node_modules, or inside .git: never listed.
        fake_repo(&root.join("a/vendor/nested"));
        fake_repo(&root.join("web/node_modules/dep"));
        std::fs::create_dir_all(root.join("plain/.git")).unwrap(); // no HEAD: not a repo
        std::fs::create_dir_all(root.join("linked")).unwrap();
        std::fs::write(
            root.join("linked/.git"),
            "gitdir: /elsewhere/.git/worktrees/x\n",
        )
        .unwrap();

        let scanner = scanner();
        let shallow = scanner.scan(&request(root, 1)).unwrap();
        assert_eq!(names(&shallow), vec!["a", "linked"]);
        let deep = scanner.scan(&request(root, 3)).unwrap();
        assert_eq!(names(&deep), vec!["a", "b", "c", "linked"]);
        assert!(!deep.truncated);
        assert!(deep.repos.iter().all(|r| r.known_id.is_none()));
    }

    #[test]
    fn flags_known_repos_and_lists_a_root_that_is_a_repo() {
        let dir = tempfile::tempdir().unwrap();
        let root = normalize(dir.path());
        fake_repo(&root.join("known"));
        let scanner = scanner();
        let path = display_path(&root.join("known"));
        let id = scanner.store.touch_repo(&path, "known").unwrap();
        let result = scanner.scan(&request(&root, 2)).unwrap();
        assert_eq!(result.repos[0].known_id, Some(id));

        let alone = scanner.scan(&request(&root.join("known"), 2)).unwrap();
        assert_eq!(names(&alone), vec!["known"]);
    }

    #[test]
    fn rejects_bad_requests() {
        let scanner = scanner();
        let dir = tempfile::tempdir().unwrap();
        assert!(scanner.scan(&request(Path::new("relative"), 2)).is_err());
        assert!(scanner.scan(&request(&dir.path().join("none"), 2)).is_err());
        assert!(scanner.scan(&request(dir.path(), 0)).is_err());
        assert!(scanner.scan(&request(dir.path(), 9)).is_err());
    }

    #[test]
    fn a_cancelled_scan_stops() {
        let dir = tempfile::tempdir().unwrap();
        let scanner = scanner();
        let token = CancelToken::new();
        token.cancel();
        let err = scanner
            .walk(&request(dir.path(), 2), dir.path(), &token)
            .unwrap_err();
        assert_eq!(err.code, crate::git::errors::ErrorCode::Cancelled);
    }
}
