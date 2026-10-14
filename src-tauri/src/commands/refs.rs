//! Branches, checkout, stashes and tags (M2-3). Writes run on the repository's `OpQueue`
//! (`op-started` / `op-finished`); each command resolves once its operation is done.

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::git::errors::YagguiError;
use crate::git::ops::types::{
    BranchStart, CheckoutMode, CheckoutResult, CheckoutTarget, CreateTagRequest,
    DeleteBranchRequest, DeleteBranchResult, DeletedRef, RefNameKind, StashEntryInfo, StashId,
    StashPushRequest,
};
use crate::state::AppState;

/// Checks a new branch or tag name as typed (`git check-ref-format`), and that no ref of
/// that kind has it yet. Errors: `invalidRefName`, `refExists`. Read-only, not queued.
#[tauri::command]
#[specta::specta]
pub async fn validate_ref_name(
    state: State<'_, AppState>,
    repo_id: u32,
    kind: RefNameKind,
    name: String,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.validate_ref_name(repo_id, kind, &name)).await
}

/// Checks out a branch, a remote branch (local tracking branch, created if missing) or a
/// detached revision. Errors: `dirtyWorktree` (payload: files, `canCarry`), `stashConflict`
/// (stash-checkout-pop: checkout done, stash kept).
#[tauri::command]
#[specta::specta]
pub async fn checkout(
    state: State<'_, AppState>,
    repo_id: u32,
    target: CheckoutTarget,
    mode: CheckoutMode,
) -> Result<CheckoutResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.checkout(repo_id, target, mode)).await
}

/// Creates a local branch, optionally checked out (local changes carried, `dirtyWorktree`
/// when they conflict).
#[tauri::command]
#[specta::specta]
pub async fn create_branch(
    state: State<'_, AppState>,
    repo_id: u32,
    name: String,
    from: BranchStart,
    checkout: bool,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.create_branch(repo_id, &name, from, checkout)).await
}

/// Renames a local branch (the current one included); its upstream setting follows.
#[tauri::command]
#[specta::specta]
pub async fn rename_branch(
    state: State<'_, AppState>,
    repo_id: u32,
    name: String,
    new_name: String,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.rename_branch(repo_id, &name, &new_name)).await
}

/// Deletes a local branch, and its upstream branch on the remote when asked (cancellable
/// then). Errors: `branchNotMerged` (action `forceDelete`), `currentBranch`.
#[tauri::command]
#[specta::specta]
pub async fn delete_branch(
    state: State<'_, AppState>,
    repo_id: u32,
    request: DeleteBranchRequest,
) -> Result<DeleteBranchResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.delete_branch(repo_id, request)).await
}

/// Sets the upstream of a local branch to a remote branch (`origin/main`).
#[tauri::command]
#[specta::specta]
pub async fn set_upstream(
    state: State<'_, AppState>,
    repo_id: u32,
    branch: String,
    upstream: String,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.set_upstream(repo_id, &branch, &upstream)).await
}

#[tauri::command]
#[specta::specta]
pub async fn unset_upstream(
    state: State<'_, AppState>,
    repo_id: u32,
    branch: String,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.unset_upstream(repo_id, &branch)).await
}

/// Stashes local changes. Error: `nothingToStash`. Returns the new `stash@{0}`.
#[tauri::command]
#[specta::specta]
pub async fn stash_push(
    state: State<'_, AppState>,
    repo_id: u32,
    request: StashPushRequest,
) -> Result<StashEntryInfo, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.stash_push(repo_id, request)).await
}

/// Applies a stash and keeps it. Errors: `stashConflict`, `dirtyWorktree`, `staleRefs`.
#[tauri::command]
#[specta::specta]
pub async fn stash_apply(
    state: State<'_, AppState>,
    repo_id: u32,
    stash: StashId,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.stash_apply(repo_id, stash)).await
}

/// Applies a stash, then drops it when it applied without conflict (`stashConflict`: kept).
/// Returns the dropped entry, for the undo.
#[tauri::command]
#[specta::specta]
pub async fn stash_pop(
    state: State<'_, AppState>,
    repo_id: u32,
    stash: StashId,
) -> Result<StashEntryInfo, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.stash_pop(repo_id, stash)).await
}

/// Drops a stash. Returns its commit and message, enough to restore it (undo).
#[tauri::command]
#[specta::specta]
pub async fn stash_drop(
    state: State<'_, AppState>,
    repo_id: u32,
    stash: StashId,
) -> Result<StashEntryInfo, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.stash_drop(repo_id, stash)).await
}

/// Changes a stash message (drop + store of the same commit): it becomes `stash@{0}`.
#[tauri::command]
#[specta::specta]
pub async fn stash_rename(
    state: State<'_, AppState>,
    repo_id: u32,
    stash: StashId,
    message: String,
) -> Result<StashEntryInfo, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.stash_rename(repo_id, stash, &message)).await
}

/// `git stash branch`: new branch at the stash's base, checked out, stash applied then
/// dropped (kept on conflict: `stashConflict`).
#[tauri::command]
#[specta::specta]
pub async fn stash_branch(
    state: State<'_, AppState>,
    repo_id: u32,
    stash: StashId,
    name: String,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.stash_branch(repo_id, stash, &name)).await
}

/// Creates a lightweight or annotated tag.
#[tauri::command]
#[specta::specta]
pub async fn create_tag(
    state: State<'_, AppState>,
    repo_id: u32,
    request: CreateTagRequest,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.create_tag(repo_id, request)).await
}

/// Deletes a local tag (remotes untouched). Returns where it pointed, for the undo.
#[tauri::command]
#[specta::specta]
pub async fn delete_tag(
    state: State<'_, AppState>,
    repo_id: u32,
    name: String,
) -> Result<DeletedRef, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.delete_tag(repo_id, &name)).await
}
