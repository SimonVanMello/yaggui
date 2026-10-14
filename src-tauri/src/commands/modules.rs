//! Submodules, worktrees and Git LFS (M4-5, F-260 to F-262). Writes run on the repository's
//! `OpQueue` (`op-started` / `op-finished`); each command resolves once its operation is done.

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::git::errors::YagguiError;
use crate::git::ops::modules::{
    CreateWorktreeRequest, LfsStatus, SubmoduleUpdateRequest, WorktreeRemovePreview,
};
use crate::git::read::submodules::SubmoduleStatus;
use crate::state::AppState;

/// Recorded vs checked out commit and local changes of each submodule. Not queued.
#[tauri::command]
#[specta::specta]
pub async fn submodule_status(
    state: State<'_, AppState>,
    repo_id: u32,
) -> Result<Vec<SubmoduleStatus>, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.submodule_status(repo_id)).await
}

/// `git submodule update [--init] [--recursive]`, with progress; cancellable.
#[tauri::command]
#[specta::specta]
pub async fn update_submodules(
    state: State<'_, AppState>,
    repo_id: u32,
    request: SubmoduleUpdateRequest,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.update_submodules(repo_id, request)).await
}

/// `git worktree add` on an existing or new branch. Returns the absolute path of the new
/// worktree. Errors: `targetNotEmpty`, `branchInOtherWorktree`, `invalidRefName`, `refExists`.
#[tauri::command]
#[specta::specta]
pub async fn create_worktree(
    state: State<'_, AppState>,
    repo_id: u32,
    request: CreateWorktreeRequest,
) -> Result<String, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.create_worktree(repo_id, request)).await
}

/// What removing a linked worktree would do, for its confirmation. Not queued.
#[tauri::command]
#[specta::specta]
pub async fn worktree_remove_preview(
    state: State<'_, AppState>,
    repo_id: u32,
    path: String,
) -> Result<WorktreeRemovePreview, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.worktree_remove_preview(repo_id, &path)).await
}

/// `git worktree remove`. Errors: `worktreeDirty` (retry with `force`), `worktreeLocked`.
#[tauri::command]
#[specta::specta]
pub async fn remove_worktree(
    state: State<'_, AppState>,
    repo_id: u32,
    path: String,
    force: bool,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.remove_worktree(repo_id, &path, force)).await
}

/// `git worktree prune`.
#[tauri::command]
#[specta::specta]
pub async fn prune_worktrees(state: State<'_, AppState>, repo_id: u32) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.prune_worktrees(repo_id)).await
}

/// LFS use, tracked patterns and `git lfs` version (`None` when not installed). Not queued.
#[tauri::command]
#[specta::specta]
pub async fn lfs_status(
    state: State<'_, AppState>,
    repo_id: u32,
) -> Result<LfsStatus, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.lfs_status(repo_id)).await
}

/// `git lfs pull`; cancellable. Error: `lfsNotInstalled`.
#[tauri::command]
#[specta::specta]
pub async fn lfs_pull(state: State<'_, AppState>, repo_id: u32) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.lfs_pull(repo_id)).await
}

/// `git lfs track <pattern>`. Error: `lfsNotInstalled`.
#[tauri::command]
#[specta::specta]
pub async fn lfs_track(
    state: State<'_, AppState>,
    repo_id: u32,
    pattern: String,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.lfs_track(repo_id, &pattern)).await
}
