//! Submodules, worktrees and Git LFS services of `RepoManager` (M4-5, F-260 to F-262).
//! Writes run on the repository's `OpQueue` through `git/cli.rs`; reads use gix, except
//! `git lfs version` (the only way to know the extension is installed).

use std::path::{Path, PathBuf};

use crate::events::OpKind;
use crate::git::cli::GitCommand;
use crate::git::errors::{BackendError, YagguiError};
use crate::git::ops::modules::{
    CreateWorktreeRequest, LfsStatus, SubmoduleUpdateRequest, WorktreeBranch, WorktreeRemovePreview,
};
use crate::git::ops::types::{JournalOp, RefNameKind, UndoBlock};
use crate::git::read::diff::WorktreeStatus;
use crate::git::read::lfs;
use crate::git::read::refs::{WorktreeRef, read_worktrees};
use crate::git::read::state::{DirtyState, HeadState};
use crate::git::read::submodules::{SubmoduleStatus, submodule_statuses};

use super::RepoManager;
use super::journal::{Mode, Plan};
use super::ref_ops::{check_new_name, classify, existing_branch, raw};
use super::write::Backup;

impl RepoManager {
    // --- Submodules (F-260) -------------------------------------------------------------

    /// Recorded and checked out commit of each submodule, and whether it has local changes.
    /// Read-only, not queued.
    pub fn submodule_status(&self, repo_id: u32) -> Result<Vec<SubmoduleStatus>, YagguiError> {
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        submodule_statuses(&repo)
    }

    /// `git submodule update` (optionally `--init`, `--recursive`) on the given submodules, or
    /// all of them. Cancellable, with the progress of the clones.
    pub fn update_submodules(
        &self,
        repo_id: u32,
        request: SubmoduleUpdateRequest,
    ) -> Result<(), YagguiError> {
        self.journal_op(repo_id, OpKind::Submodule, true, false, move |ctx| {
            let known = submodule_paths(ctx.repo);
            if let Some(unknown) = request.paths.iter().find(|p| !known.contains(p)) {
                return Err(YagguiError::invalid_argument(
                    format!("\"{unknown}\" is not a submodule of this repository."),
                    format!("« {unknown} » n'est pas un submodule de ce dépôt."),
                ));
            }
            let mut command = ctx.command(["submodule", "update", "--progress"]);
            if request.init {
                command = command.arg("--init");
            }
            if request.recursive {
                command = command.arg("--recursive");
            }
            command = command.arg("--");
            for path in &request.paths {
                command = command.arg(path);
            }
            let run = ctx.run_progress(&command)?;
            if !run.success {
                return Err(classify(ctx, &run));
            }
            // It may fetch and moves the submodules' checkouts: not undone (orchestration
            // decision for M4-5), but a barrier in the journal.
            let count = u32::try_from(request.paths.len()).unwrap_or(u32::MAX);
            Ok((
                (),
                Some(Plan::blocked(
                    JournalOp::UpdateSubmodules { count },
                    UndoBlock::Downloaded,
                )),
            ))
        })
    }

    // --- Worktrees (F-261) --------------------------------------------------------------

    /// `git worktree add` at `request.path` on an existing or a new branch. Returns the
    /// absolute path of the new worktree, as `WorktreeRef::path` lists it.
    pub fn create_worktree(
        &self,
        repo_id: u32,
        request: CreateWorktreeRequest,
    ) -> Result<String, YagguiError> {
        let path = checked_new_folder(&request.path)?;
        self.journal_op(repo_id, OpKind::Worktree, true, false, move |ctx| {
            let command = match &request.branch {
                WorktreeBranch::Existing { name } => {
                    existing_branch(ctx, name)?;
                    if let Some(other) = worktree_of_branch(ctx.repo, name) {
                        return Err(YagguiError::branch_in_other_worktree(name, Some(&other)));
                    }
                    ctx.command(["worktree", "add", "--"]).arg(&path).arg(name)
                }
                WorktreeBranch::New { name, start } => {
                    check_new_name(ctx, RefNameKind::Branch, name)?;
                    let start = checked_revision(ctx.repo, start)?;
                    ctx.command(["worktree", "add", "-b", name, "--"])
                        .arg(&path)
                        .arg(start)
                }
            };
            let run = raw(ctx, &command)?;
            if !run.success {
                return Err(classify(ctx, &run));
            }
            let created = crate::system::paths::canonical(&path).display().to_string();
            let branch = match &request.branch {
                WorktreeBranch::Existing { name } | WorktreeBranch::New { name, .. } => name,
            };
            let plan = Plan::new(
                JournalOp::CreateWorktree {
                    path: created.clone(),
                    branch: Some(branch.clone()),
                },
                Mode::Worktree {
                    path: created.clone(),
                    checkout: branch.clone(),
                    detach: false,
                    added: true,
                },
            );
            Ok((created, Some(plan)))
        })
    }

    /// What removing the linked worktree at `path` would do (branch kept, changes lost).
    /// Read-only, not queued.
    pub fn worktree_remove_preview(
        &self,
        repo_id: u32,
        path: &str,
    ) -> Result<WorktreeRemovePreview, YagguiError> {
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        let worktree = linked_worktree(&repo, path)?;
        let dirty = if worktree.prunable {
            DirtyState::default()
        } else {
            let other =
                gix::open(&worktree.path).map_err(|e| BackendError::gix("open the worktree", e))?;
            WorktreeStatus::read(&other)?.dirty()
        };
        Ok(WorktreeRemovePreview {
            branch: match &worktree.head {
                Some(HeadState::Branch { name, .. } | HeadState::Unborn { name }) => {
                    Some(name.clone())
                }
                _ => None,
            },
            path: worktree.path,
            dirty,
            locked: worktree.locked,
            missing: worktree.prunable,
        })
    }

    /// `git worktree remove`: refused with `worktreeDirty` when it has local changes, unless
    /// `force` (they are lost). The branch stays. Never the main or the current worktree.
    pub fn remove_worktree(
        &self,
        repo_id: u32,
        path: &str,
        force: bool,
    ) -> Result<(), YagguiError> {
        let path = path.to_owned();
        self.journal_op(repo_id, OpKind::Worktree, false, false, move |ctx| {
            let worktree = linked_worktree(ctx.repo, &path)?;
            if worktree.locked {
                return Err(YagguiError::worktree_locked(&worktree.path));
            }
            let plan = removal_plan(&worktree)?;
            let mut command = ctx.command(["worktree", "remove"]);
            if force {
                command = command.arg("--force");
            }
            let run = raw(ctx, &command.arg("--").arg(&worktree.path))?;
            if run.success {
                Ok(((), plan))
            } else {
                Err(classify(ctx, &run))
            }
        })
    }

    /// `git worktree prune`: forgets the worktrees whose folder was deleted.
    pub fn prune_worktrees(&self, repo_id: u32) -> Result<(), YagguiError> {
        self.write_op(repo_id, OpKind::Worktree, false, |ctx| {
            ctx.run(&ctx.command(["worktree", "prune"])).map(drop)
        })
    }

    // --- Git LFS (F-262) ----------------------------------------------------------------

    /// Whether the repository uses LFS, its tracked patterns and the `git lfs` version
    /// (`None`: not installed, which is not an error). Not queued.
    pub fn lfs_status(&self, repo_id: u32) -> Result<LfsStatus, YagguiError> {
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        let index = repo
            .index_or_empty()
            .map_err(|e| BackendError::gix("read index", e))?;
        let run = self.git.run_raw(
            &GitCommand::new(["lfs", "version"])
                .cwd(&session.workdir)
                .repo(repo_id),
            None,
            None,
        )?;
        let version = run.stdout.trim();
        Ok(LfsStatus {
            version: (run.success && !version.is_empty()).then(|| version.to_owned()),
            patterns: root_lfs_patterns(&repo, &index),
            used: lfs::may_use_lfs(&repo, &index),
        })
    }

    /// `git lfs pull`: downloads the LFS content of the checkout and replaces the pointers.
    /// `lfsNotInstalled` without the extension. Cancellable.
    pub fn lfs_pull(&self, repo_id: u32) -> Result<(), YagguiError> {
        self.journal_op(repo_id, OpKind::Lfs, true, false, |ctx| {
            let run = ctx.run_progress(&ctx.command(["lfs", "pull"]))?;
            if run.success {
                let plan = Plan::blocked(JournalOp::LfsPull, UndoBlock::Downloaded);
                Ok(((), Some(plan)))
            } else {
                Err(classify(ctx, &run))
            }
        })
    }

    /// `git lfs track <pattern>`: adds the pattern to `.gitattributes` (left unstaged).
    pub fn lfs_track(&self, repo_id: u32, pattern: &str) -> Result<(), YagguiError> {
        let pattern = checked_pattern(pattern)?;
        let backups = self.backup_dir();
        self.journal_op(repo_id, OpKind::Lfs, false, false, move |ctx| {
            // `.gitattributes` as it was, so the undo can put it back (journal `Files` mode).
            let mut backup = Backup::create(&backups?, ctx, "lfsTrack")?;
            backup.save(ctx, ".gitattributes", false)?;
            let (_, saved) = backup.finish()?;
            let run = raw(ctx, &ctx.command(["lfs", "track", "--"]).arg(&pattern))?;
            if !run.success {
                return Err(classify(ctx, &run));
            }
            let plan = Plan::new(JournalOp::LfsTrack { pattern }, Mode::Files).with_files(saved);
            Ok(((), Some(plan)))
        })
    }
}

/// How a worktree removal is journaled: undoable (added back on its branch or commit) when
/// nothing is lost, a barrier when it had local changes, nothing when its folder was gone.
fn removal_plan(worktree: &WorktreeRef) -> Result<Option<Plan>, YagguiError> {
    if worktree.prunable {
        return Ok(None);
    }
    let (branch, checkout, detach) = match &worktree.head {
        Some(HeadState::Branch { name, .. }) => (Some(name.clone()), name.clone(), false),
        Some(HeadState::Detached { oid }) => (None, oid.clone(), true),
        _ => return Ok(None),
    };
    let op = JournalOp::RemoveWorktree {
        path: worktree.path.clone(),
        branch,
    };
    let opened =
        gix::open(&worktree.path).map_err(|e| BackendError::gix("open the worktree", e))?;
    if !WorktreeStatus::read(&opened)?.dirty().is_clean() {
        return Ok(Some(Plan::blocked(op, UndoBlock::FilesDeleted)));
    }
    Ok(Some(Plan::new(
        op,
        Mode::Worktree {
            path: worktree.path.clone(),
            checkout,
            detach,
            added: false,
        },
    )))
}

fn submodule_paths(repo: &gix::Repository) -> Vec<String> {
    repo.submodules()
        .ok()
        .flatten()
        .map(|modules| {
            modules
                .filter_map(|m| m.path().ok().map(|p| p.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// A linked worktree of the repository, other than the one this session shows.
fn linked_worktree(repo: &gix::Repository, path: &str) -> Result<WorktreeRef, YagguiError> {
    let wanted = crate::system::paths::canonical(Path::new(path));
    read_worktrees(repo)
        .into_iter()
        .find(|w| !w.is_main && !w.is_current && Path::new(&w.path) == wanted)
        .ok_or_else(|| {
            YagguiError::invalid_argument(
                format!("{path} is not a linked worktree that can be removed from here."),
                format!("{path} n'est pas un worktree lié qui peut être supprimé d'ici."),
            )
        })
}

/// The worktree where `branch` is checked out, if any.
fn worktree_of_branch(repo: &gix::Repository, branch: &str) -> Option<String> {
    read_worktrees(repo)
        .into_iter()
        .find(|w| matches!(&w.head, Some(HeadState::Branch { name, .. } | HeadState::Unborn { name }) if name == branch))
        .map(|w| w.path)
}

/// Folder of a new worktree: absolute, and absent or empty (what `git worktree add` accepts).
fn checked_new_folder(path: &str) -> Result<PathBuf, YagguiError> {
    let folder = PathBuf::from(path);
    if path.trim().is_empty() || !folder.is_absolute() || path.contains('\0') {
        return Err(YagguiError::invalid_argument(
            format!("Expected an absolute folder path, got \"{path}\"."),
            format!("Chemin de dossier absolu attendu, reçu « {path} »."),
        ));
    }
    match std::fs::read_dir(&folder) {
        Ok(mut entries) => match entries.next() {
            Some(_) => Err(YagguiError::target_not_empty(path)),
            None => Ok(folder),
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(folder),
        // A file, or a folder that cannot be read: Git would refuse it too.
        Err(_) => Err(YagguiError::target_not_empty(path)),
    }
}

/// Full SHA of the commit `rev` names; `revisionNotFound` otherwise.
fn checked_revision(repo: &gix::Repository, rev: &str) -> Result<String, YagguiError> {
    if rev.is_empty() || rev.starts_with('-') {
        return Err(YagguiError::revision_not_found(rev));
    }
    repo.rev_parse_single(rev)
        .ok()
        .and_then(|id| id.object().ok()?.peel_to_commit().ok())
        .map(|commit| commit.id.to_string())
        .ok_or_else(|| YagguiError::revision_not_found(rev))
}

/// A pattern for `git lfs track`: one line, not an option.
fn checked_pattern(pattern: &str) -> Result<String, YagguiError> {
    let pattern = pattern.trim();
    if pattern.is_empty() || pattern.starts_with('-') || pattern.contains(['\n', '\r', '\0']) {
        return Err(YagguiError::invalid_argument(
            format!("\"{pattern}\" is not a file pattern (e.g. *.psd)."),
            format!("« {pattern} » n'est pas un motif de fichiers (ex. *.psd)."),
        ));
    }
    Ok(pattern.to_owned())
}

/// Patterns with `filter=lfs` in the root `.gitattributes` (working tree, else index).
fn root_lfs_patterns(repo: &gix::Repository, index: &gix::index::State) -> Vec<String> {
    let from_disk = repo
        .workdir()
        .and_then(|root| std::fs::read(root.join(".gitattributes")).ok());
    let data = from_disk.or_else(|| {
        let entry = index.entry_by_path(".gitattributes".into())?;
        Some(repo.find_blob(entry.id).ok()?.data.clone())
    });
    let Some(data) = data else {
        return Vec::new();
    };
    String::from_utf8_lossy(&data)
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let mut fields = line.split_whitespace();
            let pattern = fields.next()?;
            fields
                .any(|field| field == "filter=lfs")
                .then(|| pattern.to_owned())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_bad_patterns_and_folders() {
        assert_eq!(checked_pattern(" *.psd ").unwrap(), "*.psd");
        assert!(checked_pattern("").is_err());
        assert!(checked_pattern("--all").is_err());
        assert!(checked_pattern("a\nb").is_err());
        assert!(checked_new_folder("relative/path").is_err());
        assert!(checked_new_folder("").is_err());
    }
}
