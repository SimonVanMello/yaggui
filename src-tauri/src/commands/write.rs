//! Staging, discard and commit (M2-1). Every write runs on the repository's `OpQueue`, so
//! it emits `op-started` / `op-finished`; the command resolves once the operation is done.

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::git::errors::YagguiError;
use crate::git::ops::types::{
    CommitMessage, CommitRequest, CommitResult, ConfigScope, DiscardResult, GitIdentity,
    HunkChange, PathSelection,
};
use crate::state::AppState;

/// Stages whole files (`git add`), untracked and deleted ones included. `all`: every
/// unstaged change. Staging a conflicted file marks it resolved.
#[tauri::command]
#[specta::specta]
pub async fn stage_paths(
    state: State<'_, AppState>,
    repo_id: u32,
    paths: PathSelection,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.stage_paths(repo_id, paths)).await
}

/// Unstages whole files (back to HEAD in the index; a staged rename also restores its source).
#[tauri::command]
#[specta::specta]
pub async fn unstage_paths(
    state: State<'_, AppState>,
    repo_id: u32,
    paths: PathSelection,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.unstage_paths(repo_id, paths)).await
}

/// Stages hunks or lines of an unstaged diff. Refused with `staleDiff` when the file
/// changed since that diff was read.
#[tauri::command]
#[specta::specta]
pub async fn stage_hunks(
    state: State<'_, AppState>,
    repo_id: u32,
    change: HunkChange,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.stage_hunks(repo_id, change)).await
}

/// Unstages hunks or lines of a staged diff (`staleDiff` as for `stage_hunks`).
#[tauri::command]
#[specta::specta]
pub async fn unstage_hunks(
    state: State<'_, AppState>,
    repo_id: u32,
    change: HunkChange,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.unstage_hunks(repo_id, change)).await
}

/// Reverts hunks or lines of an unstaged diff in the working tree, after saving the file.
#[tauri::command]
#[specta::specta]
pub async fn discard_hunks(
    state: State<'_, AppState>,
    repo_id: u32,
    change: HunkChange,
) -> Result<DiscardResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.discard_hunks(repo_id, change)).await
}

/// Discards the working tree changes of files (tracked: restored from the index, untracked:
/// deleted), after saving their content. `include_staged` also resets them to HEAD in the
/// index (files added since HEAD are then deleted).
#[tauri::command]
#[specta::specta]
pub async fn discard_paths(
    state: State<'_, AppState>,
    repo_id: u32,
    paths: PathSelection,
    include_staged: bool,
) -> Result<DiscardResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.discard_paths(repo_id, paths, include_staged)).await
}

/// Saves a file edited in the diff view, unless it changed on disk since `version` was read.
/// Returns the version written.
#[tauri::command]
#[specta::specta]
pub async fn save_worktree_file(
    state: State<'_, AppState>,
    repo_id: u32,
    path: String,
    content: String,
    version: String,
) -> Result<String, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.save_worktree_file(repo_id, path, content, version)).await
}

/// Commits the index (or amends HEAD), running the hooks unless `skip_hooks`. Cancellable
/// (`cancel_op`): a hanging hook and the processes it started are killed.
#[tauri::command]
#[specta::specta]
pub async fn commit(
    state: State<'_, AppState>,
    repo_id: u32,
    request: CommitRequest,
) -> Result<CommitResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.commit(repo_id, request)).await
}

/// Message of the HEAD commit, to pre-fill an amend. `None` on an unborn branch.
#[tauri::command]
#[specta::specta]
pub async fn last_commit_message(
    state: State<'_, AppState>,
    repo_id: u32,
) -> Result<Option<CommitMessage>, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.last_commit_message(repo_id)).await
}

/// `user.name` / `user.email` as resolved for the repository (local, global, system).
#[tauri::command]
#[specta::specta]
pub async fn git_identity(
    state: State<'_, AppState>,
    repo_id: u32,
) -> Result<GitIdentity, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.git_identity(repo_id)).await
}

/// Writes `user.name` and `user.email` (both required) to the repository or global config.
#[tauri::command]
#[specta::specta]
pub async fn set_git_identity(
    state: State<'_, AppState>,
    repo_id: u32,
    name: String,
    email: String,
    scope: ConfigScope,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.set_git_identity(repo_id, &name, &email, scope)).await
}
