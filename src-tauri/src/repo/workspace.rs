//! Workspace services of `RepoManager` (F-006 to F-009): overview of known repos that may not
//! be open, fetch of every repo of a workspace, import of scanned folders, relocation of a
//! moved repo. Reads use `gix` directly; fetches go through the repo's `OpQueue` like any write.

use std::path::Path;
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::git::errors::YagguiError;
use crate::git::ops::types::FetchTarget;
use crate::git::read::state::{self, RepoState};
use crate::store::KnownRepo;

use super::{RepoManager, display_path, normalize};

/// Overview reads running at once: each one scans a working tree, which is disk bound.
const OVERVIEW_SLOTS: usize = 4;
/// Workspace fetches running at once.
const FETCH_SLOTS: usize = 4;

static OVERVIEW_PERMITS: Semaphore = Semaphore::new(OVERVIEW_SLOTS);
static FETCH_PERMITS: Semaphore = Semaphore::new(FETCH_SLOTS);

/// Counting semaphore bounding the blocking work started by many commands at once (one
/// command per repo of a workspace).
struct Semaphore {
    used: Mutex<usize>,
    freed: Condvar,
    max: usize,
}

struct Permit<'a>(&'a Semaphore);

impl Semaphore {
    const fn new(max: usize) -> Self {
        Self {
            used: Mutex::new(0),
            freed: Condvar::new(),
            max,
        }
    }

    fn acquire(&self) -> Permit<'_> {
        let mut used = self.used.lock().unwrap_or_else(PoisonError::into_inner);
        while *used >= self.max {
            used = self
                .freed
                .wait(used)
                .unwrap_or_else(PoisonError::into_inner);
        }
        *used += 1;
        Permit(self)
    }
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        let mut used = self.0.used.lock().unwrap_or_else(PoisonError::into_inner);
        *used = used.saturating_sub(1);
        self.0.freed.notify_one();
    }
}

/// One row of the workspace overview (F-008).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RepoOverview {
    #[serde(rename_all = "camelCase")]
    Ready {
        state: RepoState,
        /// Last fetch (modification of `FETCH_HEAD`), seconds since the Unix epoch; `None`
        /// if the repo was never fetched.
        last_fetched_at: Option<u32>,
    },
    /// The folder is gone, or no longer holds a repository (F-009).
    Missing,
    Failed {
        error: YagguiError,
    },
}

/// Outcome of `import_repos`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// Ids of the imported repos (new or already known), in the order of the request.
    pub repo_ids: Vec<u32>,
    pub failed: Vec<ImportFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    pub path: String,
    pub error: YagguiError,
}

impl RepoManager {
    /// Branch, upstream, dirty counts and last fetch of a known repo, open or not. Never
    /// fails for a repo problem: that is reported in the result.
    pub fn repo_overview(&self, repo_id: u32) -> Result<RepoOverview, YagguiError> {
        let known = self.known(repo_id)?;
        let _permit = OVERVIEW_PERMITS.acquire();
        let path = Path::new(&known.path);
        if !path.is_dir() {
            return Ok(RepoOverview::Missing);
        }
        let read = || -> Result<RepoOverview, YagguiError> {
            let (state, git_dirs) = match self.get(repo_id) {
                // An open session shares its cached status with the tab.
                Some(session) => {
                    let repo = session.repo()?.to_thread_local();
                    (session.state()?, fetch_head_dirs(&repo))
                }
                None => {
                    let Ok(repo) = gix::open(path) else {
                        return Ok(RepoOverview::Missing);
                    };
                    if repo.workdir().is_none() {
                        return Ok(RepoOverview::Missing);
                    }
                    (state::read_state(&repo)?, fetch_head_dirs(&repo))
                }
            };
            let last_fetched_at = git_dirs
                .iter()
                .filter_map(|dir| {
                    std::fs::metadata(dir.join("FETCH_HEAD"))
                        .ok()?
                        .modified()
                        .ok()
                })
                .max()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|d| u32::try_from(d.as_secs()).unwrap_or(u32::MAX));
            Ok(RepoOverview::Ready {
                state,
                last_fetched_at,
            })
        };
        Ok(read().unwrap_or_else(|error| RepoOverview::Failed { error }))
    }

    /// `git fetch --all` of a known repo, on its queue: joins the session of its tab if it
    /// is open, else opens one for the time of the fetch.
    pub fn fetch_known(&self, repo_id: u32, prune: bool) -> Result<(), YagguiError> {
        let known = self.known(repo_id)?;
        let _permit = FETCH_PERMITS.acquire();
        let info = self.open_with(&known.path, false)?;
        let result = self.fetch(info.id, FetchTarget::All, prune);
        self.close(info.id);
        result
    }

    /// Adds repositories found by a folder scan to the known repos, and to a workspace if
    /// given. A folder that is not (or no longer) a repository is reported, not imported.
    pub fn import_repos(
        &self,
        paths: &[String],
        workspace_id: Option<u32>,
    ) -> Result<ImportResult, YagguiError> {
        if let Some(id) = workspace_id {
            self.store.workspace(id)?;
        }
        let mut repo_ids = Vec::new();
        let mut failed = Vec::new();
        for path in paths {
            match self.locate(path) {
                Ok((shown, name)) => {
                    let id = self.store.ensure_repo(&shown, &name)?;
                    if !repo_ids.contains(&id) {
                        repo_ids.push(id);
                    }
                }
                Err(error) => failed.push(ImportFailure {
                    path: path.clone(),
                    error,
                }),
            }
        }
        if let Some(id) = workspace_id {
            self.store.add_to_workspace(id, &repo_ids)?;
        }
        Ok(ImportResult { repo_ids, failed })
    }

    /// Points a moved repo to its new folder (F-009). Returns the updated entry, whose id
    /// differs if the folder was already known (both entries are merged).
    pub fn relocate_repo(&self, repo_id: u32, path: &str) -> Result<KnownRepo, YagguiError> {
        self.known(repo_id)?;
        let (shown, name) = self.locate(path)?;
        // A session on the old folder is stale.
        self.close_all(repo_id);
        self.store.relocate_repo(repo_id, &shown, &name)
    }

    fn known(&self, repo_id: u32) -> Result<KnownRepo, YagguiError> {
        self.store.repo(repo_id)?.ok_or_else(|| {
            YagguiError::invalid_argument(
                format!("Unknown repository #{repo_id}."),
                format!("Dépôt n°{repo_id} inconnu."),
            )
        })
    }

    /// Worktree root (as stored) and name of the repository at `path`, which must be the
    /// root itself: picking a subfolder of a repo is more likely a mistake than a shortcut.
    fn locate(&self, path: &str) -> Result<(String, String), YagguiError> {
        let requested = Path::new(path);
        if path.trim().is_empty() || !requested.is_absolute() {
            return Err(YagguiError::invalid_argument(
                format!("Expected an absolute folder path, got \"{path}\"."),
                format!("Chemin de dossier absolu attendu, reçu « {path} »."),
            ));
        }
        if !requested.is_dir() {
            return Err(YagguiError::repo_not_found(path));
        }
        let repo = gix::open(requested)
            .map_err(|err| YagguiError::not_a_repository(path).with_detail(err.to_string()))?;
        let Some(workdir) = repo.workdir().map(normalize) else {
            return Err(YagguiError::invalid_argument(
                "Bare repositories are not supported yet.",
                "Les dépôts nus ne sont pas encore pris en charge.",
            ));
        };
        if workdir != normalize(requested) {
            return Err(YagguiError::not_a_repository(path));
        }
        let shown = display_path(&workdir);
        let name = workdir
            .file_name()
            .map_or_else(|| shown.clone(), |n| n.to_string_lossy().into_owned());
        Ok((shown, name))
    }
}

/// Where `git fetch` writes `FETCH_HEAD`: the worktree's git dir, or the common one.
fn fetch_head_dirs(repo: &gix::Repository) -> Vec<std::path::PathBuf> {
    vec![
        repo.git_dir().to_path_buf(),
        repo.common_dir().to_path_buf(),
    ]
}
