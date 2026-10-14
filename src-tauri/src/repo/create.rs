//! Clone and init (F-002, F-003): creating a repository where none is open yet.
//!
//! There is no `RepoSession`, so no `OpQueue` (it serializes the writes of one repository):
//! these commands still go through `git/cli.rs`, with progress and cancellation. A clone is
//! identified by an id chosen by the frontend, so it can be cancelled before the command
//! has returned.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::events::{BackendEvent, CloneProgress, EventSink};
use crate::git::cli::{CancelToken, GitCli, GitCommand, GitProgress};
use crate::git::errors::{BackendError, YagguiError};
use crate::git::ops::gitignore::{self, GitignoreTemplate};
use crate::store::Store;

/// Branch proposed when Git has no `init.defaultBranch`.
pub const FALLBACK_BRANCH: &str = "main";
const MAX_DEPTH: u32 = 1_000_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CloneRequest {
    /// Chosen by the frontend; tags `clone-progress` events and targets `cancel_clone`.
    pub clone_id: String,
    /// HTTPS, SSH (`git@host:path`, `ssh://`) or local (`file://`, a path) address.
    pub url: String,
    /// Absolute path of the folder to create (or to fill, if it exists and is empty).
    pub target: String,
    /// Branch or tag to check out instead of the remote's default branch.
    pub branch: Option<String>,
    /// Shallow clone: number of commits kept.
    pub depth: Option<u32>,
    pub recurse_submodules: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CloneResult {
    /// Worktree of the new repository, ready for `open_repo`.
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InitRequest {
    /// Absolute path of the folder; created if missing.
    pub target: String,
    pub default_branch: String,
    pub gitignore: Vec<GitignoreTemplate>,
    pub readme: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InitResult {
    pub path: String,
    /// Files written next to `.git`; an existing `.gitignore` or README is never replaced.
    pub created_files: Vec<String>,
}

/// Starting values of the clone and init dialogs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewRepoDefaults {
    /// Folder used last for a clone or an init, if it still exists.
    pub parent_dir: Option<String>,
    /// `init.defaultBranch` of the Git configuration, else `main`.
    pub default_branch: String,
}

/// What to remove if the operation does not complete.
enum Cleanup {
    /// The folder, or its first missing ancestor, did not exist: remove it entirely.
    Remove(PathBuf),
    /// The folder existed and was empty: empty it again, keep the folder.
    Empty(PathBuf),
}

pub struct RepoCreator {
    git: Arc<GitCli>,
    store: Arc<Store>,
    sink: Arc<dyn EventSink>,
    running: Mutex<HashMap<String, CancelToken>>,
}

impl RepoCreator {
    pub fn new(git: Arc<GitCli>, store: Arc<Store>, sink: Arc<dyn EventSink>) -> Self {
        Self {
            git,
            store,
            sink,
            running: Mutex::default(),
        }
    }

    /// Requests the cancellation of a running clone. Nothing happens if it already finished.
    pub fn cancel_clone(&self, clone_id: &str) {
        if let Some(token) = self.lock_running().get(clone_id) {
            token.cancel();
        }
    }

    pub fn clone_repo(&self, request: &CloneRequest) -> Result<CloneResult, YagguiError> {
        let url = request.url.trim();
        check_url(url)?;
        let branch = request
            .branch
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty());
        if let Some(branch) = branch {
            self.check_branch(branch)?;
        }
        if let Some(depth) = request.depth
            && !(1..=MAX_DEPTH).contains(&depth)
        {
            return Err(YagguiError::invalid_argument(
                format!("The depth must be between 1 and {MAX_DEPTH}."),
                format!("La profondeur doit être comprise entre 1 et {MAX_DEPTH}."),
            ));
        }
        let target = absolute_target(&request.target)?;
        let cleanup = prepare_target(&target)?;

        let token = CancelToken::new();
        {
            let mut running = self.lock_running();
            if request.clone_id.is_empty() || running.contains_key(&request.clone_id) {
                return Err(YagguiError::invalid_argument(
                    "This clone is already running.",
                    "Ce clonage est déjà en cours.",
                ));
            }
            running.insert(request.clone_id.clone(), token.clone());
        }

        let mut command =
            GitCommand::new(["-c", "protocol.ext.allow=never", "clone", "--progress"]);
        if let Some(branch) = branch {
            command = command.arg("--branch").arg(branch);
        }
        if let Some(depth) = request.depth {
            command = command.arg("--depth").arg(depth.to_string());
        }
        if request.recurse_submodules {
            command = command.arg("--recurse-submodules");
            if request.depth.is_some() {
                command = command.arg("--shallow-submodules");
            }
        }
        command = command.arg("--").arg(url).arg(&target);

        let clone_id = request.clone_id.clone();
        let mut report = |progress: GitProgress| {
            self.sink.emit(BackendEvent::CloneProgress(CloneProgress {
                clone_id: clone_id.clone(),
                phase: progress.phase,
                percent: progress.percent,
                current: progress.current,
                total: progress.total,
            }));
        };
        let result = self.git.run_with(&command, Some(&token), Some(&mut report));
        self.lock_running().remove(&request.clone_id);

        if let Err(err) = result {
            // Git removes what it created when it is stopped by a signal, but not when the
            // process was killed or a submodule failed after the clone: do it ourselves.
            cleanup.run();
            return Err(err);
        }
        self.remember_parent(&target);
        Ok(CloneResult {
            path: target.display().to_string(),
        })
    }

    pub fn init_repo(&self, request: &InitRequest) -> Result<InitResult, YagguiError> {
        let branch = request.default_branch.trim();
        self.check_branch(branch)?;
        let target = absolute_target(&request.target)?;
        if target.join(".git").exists() {
            return Err(YagguiError::already_repository(
                &target.display().to_string(),
            ));
        }
        if target.exists() && !target.is_dir() {
            return Err(YagguiError::target_not_empty(&target.display().to_string()));
        }
        let cleanup = missing_ancestor(&target).map(Cleanup::Remove);
        std::fs::create_dir_all(&target)
            .map_err(|err| BackendError::io(format!("cannot create {}", target.display()), err))?;

        let command = GitCommand::new(["init", "--initial-branch"])
            .arg(branch)
            .arg("--")
            .arg(&target);
        if let Err(err) = self.git.run(&command) {
            if let Some(cleanup) = cleanup {
                cleanup.run();
            }
            return Err(err);
        }

        let mut created_files = Vec::new();
        if !request.gitignore.is_empty()
            && write_new(
                &target.join(".gitignore"),
                &gitignore::render(&request.gitignore),
            )?
        {
            created_files.push(".gitignore".to_owned());
        }
        if request.readme && !has_readme(&target) {
            let title = target
                .file_name()
                .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
            if write_new(&target.join("README.md"), &format!("# {title}\n"))? {
                created_files.push("README.md".to_owned());
            }
        }
        self.remember_parent(&target);
        Ok(InitResult {
            path: target.display().to_string(),
            created_files,
        })
    }

    pub fn defaults(&self) -> Result<NewRepoDefaults, YagguiError> {
        let configured = self
            .git
            .run_raw(
                &GitCommand::new(["config", "--get", "init.defaultBranch"]),
                None,
                None,
            )
            .ok()
            .filter(|run| run.success)
            .map(|run| run.stdout.trim().to_owned())
            .filter(|branch| !branch.is_empty());
        let default_branch = match configured {
            Some(branch) if self.check_branch(&branch).is_ok() => branch,
            _ => FALLBACK_BRANCH.to_owned(),
        };
        Ok(NewRepoDefaults {
            parent_dir: self.store.last_recent_dir()?,
            default_branch,
        })
    }

    /// `git check-ref-format --branch`, without a repository (no `@{-1}` expansion).
    fn check_branch(&self, name: &str) -> Result<(), YagguiError> {
        let invalid = || YagguiError::invalid_ref_name(name, false);
        if name.is_empty() || name.starts_with('-') || name.contains("@{") || name == "HEAD" {
            return Err(invalid());
        }
        let run = self.git.run_raw(
            &GitCommand::new(["check-ref-format", "--branch", name]),
            None,
            None,
        )?;
        if run.success && run.stdout.trim_end_matches(['\n', '\r']) == name {
            Ok(())
        } else {
            Err(invalid())
        }
    }

    fn remember_parent(&self, target: &Path) {
        let Some(parent) = target.parent() else {
            return;
        };
        if let Err(err) = self.store.touch_recent_dir(&parent.display().to_string()) {
            tracing::warn!(error = %err, "cannot remember the folder");
        }
    }

    fn lock_running(&self) -> std::sync::MutexGuard<'_, HashMap<String, CancelToken>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Cleanup {
    fn run(&self) {
        let result = match self {
            Self::Remove(path) => remove_any(path),
            Self::Empty(dir) => std::fs::read_dir(dir).and_then(|mut entries| {
                entries.try_for_each(|entry| entry.and_then(|e| remove_any(&e.path())))
            }),
        };
        if let Err(err) = result {
            tracing::warn!(error = %err, "cannot clean up after a failed clone");
        }
    }
}

fn remove_any(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

/// Refuses what `git clone` would treat as an option or run as a helper.
fn check_url(url: &str) -> Result<(), YagguiError> {
    if url.is_empty() || url.starts_with('-') || url.chars().any(char::is_control) {
        return Err(YagguiError::invalid_argument(
            "Enter the address of the repository to clone.",
            "Saisis l'adresse du dépôt à cloner.",
        ));
    }
    Ok(())
}

fn absolute_target(target: &str) -> Result<PathBuf, YagguiError> {
    let target = target.trim();
    let path = Path::new(target);
    if target.is_empty() || !path.is_absolute() {
        return Err(YagguiError::invalid_argument(
            format!("Expected an absolute folder path, got \"{target}\"."),
            format!("Chemin de dossier absolu attendu, reçu « {target} »."),
        ));
    }
    Ok(path.components().collect())
}

/// Checks the destination of a clone and says what to undo if it fails: nothing to do when
/// the folder is not usable.
fn prepare_target(target: &Path) -> Result<Cleanup, YagguiError> {
    let shown = || target.display().to_string();
    match std::fs::metadata(target) {
        Ok(meta) if meta.is_dir() => {
            let mut entries = std::fs::read_dir(target)
                .map_err(|err| BackendError::io(format!("cannot read {}", shown()), err))?;
            if entries.next().is_some() {
                return Err(YagguiError::target_not_empty(&shown()));
            }
            Ok(Cleanup::Empty(target.to_path_buf()))
        }
        Ok(_) => Err(YagguiError::target_not_empty(&shown())),
        Err(_) => Ok(Cleanup::Remove(
            missing_ancestor(target).unwrap_or_else(|| target.to_path_buf()),
        )),
    }
}

/// The highest ancestor of `path` (or `path` itself) that does not exist yet.
fn missing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut missing = None;
    for ancestor in path.ancestors() {
        if ancestor.exists() {
            break;
        }
        missing = Some(ancestor.to_path_buf());
    }
    missing
}

/// Writes `text` to a file that must not exist yet; `false` when it did.
fn write_new(path: &Path, text: &str) -> Result<bool, YagguiError> {
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => {
            file.write_all(text.as_bytes())
                .map_err(|err| BackendError::io(format!("cannot write {}", path.display()), err))?;
            Ok(true)
        }
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(err) => Err(BackendError::io(format!("cannot create {}", path.display()), err).into()),
    }
}

fn has_readme(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|entries| {
        entries.flatten().any(|e| {
            e.file_name()
                .to_string_lossy()
                .to_ascii_lowercase()
                .starts_with("readme")
        })
    })
}
