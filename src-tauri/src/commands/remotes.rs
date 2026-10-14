//! Remote management and tag transfers (M4-7c). Writes run on the repository's `OpQueue`;
//! network ones (`push_all_tags`, `fetch_tags`) report `op-progress` and can be cancelled.

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::git::errors::YagguiError;
use crate::git::ops::remotes::{RemoteRemovalPreview, RemovedRemote, TagPushResult};
use crate::git::ops::types::FetchTarget;
use crate::state::AppState;

/// Live check of a new remote name. Errors: `invalidRemoteName`, `remoteExists`. Not queued.
#[tauri::command]
#[specta::specta]
pub async fn validate_remote_name(
    state: State<'_, AppState>,
    repo_id: u32,
    name: String,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.validate_remote_name(repo_id, &name)).await
}

/// What `remove_remote` would drop: tracking branches, upstreams. Read-only, not queued.
#[tauri::command]
#[specta::specta]
pub async fn remote_removal_preview(
    state: State<'_, AppState>,
    repo_id: u32,
    name: String,
) -> Result<RemoteRemovalPreview, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.remote_removal_preview(repo_id, &name)).await
}

/// `pushUrl: null` keeps pushes on `url`. Errors: `invalidRemoteName`, `remoteExists`,
/// `invalidArgument` (URL).
#[tauri::command]
#[specta::specta]
pub async fn add_remote(
    state: State<'_, AppState>,
    repo_id: u32,
    name: String,
    url: String,
    push_url: Option<String>,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.add_remote(repo_id, &name, &url, push_url)).await
}

/// Errors: `remoteNotFound`, `invalidRemoteName`, `remoteExists`.
#[tauri::command]
#[specta::specta]
pub async fn rename_remote(
    state: State<'_, AppState>,
    repo_id: u32,
    name: String,
    new_name: String,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.rename_remote(repo_id, &name, &new_name)).await
}

/// Sets the fetch URL and the push URL (`null`: removed, pushes use the fetch URL).
#[tauri::command]
#[specta::specta]
pub async fn set_remote_urls(
    state: State<'_, AppState>,
    repo_id: u32,
    name: String,
    url: String,
    push_url: Option<String>,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.set_remote_urls(repo_id, &name, &url, push_url)).await
}

/// Removes a remote and its tracking branches; returns them (undo).
#[tauri::command]
#[specta::specta]
pub async fn remove_remote(
    state: State<'_, AppState>,
    repo_id: u32,
    name: String,
) -> Result<RemovedRemote, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.remove_remote(repo_id, &name)).await
}

/// Pushes every local tag. Errors: `tagRejected` (the others are pushed), network errors.
#[tauri::command]
#[specta::specta]
pub async fn push_all_tags(
    state: State<'_, AppState>,
    repo_id: u32,
    remote: String,
) -> Result<TagPushResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.push_all_tags(repo_id, &remote)).await
}

/// `git fetch --tags` of one remote or all.
#[tauri::command]
#[specta::specta]
pub async fn fetch_tags(
    state: State<'_, AppState>,
    repo_id: u32,
    target: FetchTarget,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.fetch_tags(repo_id, target)).await
}
