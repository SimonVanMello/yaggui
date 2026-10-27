use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::git::errors::YagguiError;
use crate::git::read::state::RepoState;
use crate::repo::RepoInfo;
use crate::state::AppState;

/// Opens the repository containing `path` (or joins the already open session),
/// records it in the recent repos and starts watching it. Sessions are reference-counted:
/// call `close_repo` once per successful `open_repo` (typically one per tab).
#[tauri::command]
#[specta::specta]
pub async fn open_repo(state: State<'_, AppState>, path: String) -> Result<RepoInfo, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.open(&path)).await
}

/// Releases one `open_repo`; the last release stops watching, ends the repository's
/// integrated terminals and drops the session. No-op if it is not open.
#[tauri::command]
#[specta::specta]
pub async fn close_repo(state: State<'_, AppState>, repo_id: u32) -> Result<(), YagguiError> {
    state.repos.close(repo_id);
    if state.repos.get(repo_id).is_none() {
        let ptys = Arc::clone(&state.ptys);
        blocking(move || {
            ptys.close_repo(repo_id);
            Ok(())
        })
        .await?;
    }
    Ok(())
}

/// Current HEAD, upstream, dirty counts and operation in progress of an open repository.
#[tauri::command]
#[specta::specta]
pub async fn repo_state(
    state: State<'_, AppState>,
    repo_id: u32,
) -> Result<RepoState, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.state(repo_id)).await
}

/// Requests cancellation of a queued or running operation.
#[tauri::command]
#[specta::specta]
pub async fn cancel_op(state: State<'_, AppState>, op_id: u32) -> Result<(), YagguiError> {
    state.repos.cancel_op(op_id)
}

/// Removes `.git/index.lock`, or the `.lock` file at `path` inside the git dir (the one a
/// failed command named), if it is stale (older than 10 s). Refuses a fresh lock.
#[tauri::command]
#[specta::specta]
pub async fn remove_stale_index_lock(
    state: State<'_, AppState>,
    repo_id: u32,
    path: Option<String>,
) -> Result<(), YagguiError> {
    let handle = state.repos.remove_stale_index_lock(repo_id, path)?;
    blocking(move || handle.wait()).await
}

/// Adds `path` to the global `safe.directory` list. Only call after explicit user confirmation.
#[tauri::command]
#[specta::specta]
pub async fn add_safe_directory(
    state: State<'_, AppState>,
    path: String,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.add_safe_directory(&path)).await
}
