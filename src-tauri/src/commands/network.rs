//! Fetch, pull and push (M2-5). Network operations run on the repository's `OpQueue`
//! (`op-started` / `op-progress` / `op-finished`, cancellable with `cancel_op`); each
//! command resolves once its operation is done.

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::git::errors::YagguiError;
use crate::git::ops::remotes::TagPushResult;
use crate::git::ops::types::{
    DeletedRef, FetchTarget, ForcePushPreview, PullResult, PullStrategy, PushRequest, PushResult,
};
use crate::state::AppState;

/// Configured remotes, `origin` first. Read-only, not queued.
#[tauri::command]
#[specta::specta]
pub async fn list_remotes(
    state: State<'_, AppState>,
    repo_id: u32,
) -> Result<Vec<String>, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.remotes(repo_id)).await
}

/// Strategy `pull` uses without one (`branch.<b>.rebase`, `pull.rebase`, `pull.ff`;
/// `ffOnly` when unset). Read-only, not queued.
#[tauri::command]
#[specta::specta]
pub async fn pull_default_strategy(
    state: State<'_, AppState>,
    repo_id: u32,
) -> Result<PullStrategy, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.pull_default_strategy(repo_id)).await
}

/// `git fetch` of one remote or all, optionally with `--prune`.
/// Errors: `authFailed`, `remoteNotFound`, `hostUnreachable`.
#[tauri::command]
#[specta::specta]
pub async fn fetch(
    state: State<'_, AppState>,
    repo_id: u32,
    target: FetchTarget,
    prune: bool,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.fetch(repo_id, target, prune)).await
}

/// Pulls the checked out branch from its upstream. `strategy: null` uses the configured
/// default. Errors: `noUpstream`, `notFastForward`, `conflicts` (merge or rebase left in
/// progress, see `repo_state`), `dirtyWorktree`, network errors.
#[tauri::command]
#[specta::specta]
pub async fn pull(
    state: State<'_, AppState>,
    repo_id: u32,
    strategy: Option<PullStrategy>,
) -> Result<PullResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.pull(repo_id, strategy)).await
}

/// Pushes a branch to its upstream (or creates it with `setUpstream`). Force is
/// `--force-with-lease` only. Errors: `noUpstream` (action: set upstream), `pushRejected`
/// (action: pull then push), `staleLease`, `protectedBranch`, network errors.
#[tauri::command]
#[specta::specta]
pub async fn push(
    state: State<'_, AppState>,
    repo_id: u32,
    request: PushRequest,
) -> Result<PushResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.push(repo_id, request)).await
}

/// What a force push of `branch` (default: checked out) would drop on its upstream, as
/// of the last fetch. Read-only, not queued.
#[tauri::command]
#[specta::specta]
pub async fn force_push_preview(
    state: State<'_, AppState>,
    repo_id: u32,
    branch: Option<String>,
) -> Result<ForcePushPreview, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.force_push_preview(repo_id, branch)).await
}

/// Pushes one tag. Errors: `tagRejected` (a tag of that name points elsewhere on the
/// remote), `remoteNotFound`, network errors.
#[tauri::command]
#[specta::specta]
pub async fn push_tag(
    state: State<'_, AppState>,
    repo_id: u32,
    remote: String,
    name: String,
) -> Result<TagPushResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.push_tag(repo_id, &remote, &name)).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_remote_tag(
    state: State<'_, AppState>,
    repo_id: u32,
    remote: String,
    name: String,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.delete_remote_tag(repo_id, &remote, &name)).await
}

/// Deletes a branch on a remote; returns its former remote-tracking ref (undo).
#[tauri::command]
#[specta::specta]
pub async fn delete_remote_branch(
    state: State<'_, AppState>,
    repo_id: u32,
    remote: String,
    branch: String,
) -> Result<Option<DeletedRef>, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.delete_remote_branch(repo_id, &remote, &branch)).await
}
