use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::git::errors::YagguiError;
use crate::repo::create::{CloneRequest, CloneResult, InitRequest, InitResult, NewRepoDefaults};
use crate::state::AppState;

/// Folder used last and default branch, to fill the clone and init dialogs.
#[tauri::command]
#[specta::specta]
pub async fn new_repo_defaults(state: State<'_, AppState>) -> Result<NewRepoDefaults, YagguiError> {
    let creator = Arc::clone(&state.creator);
    blocking(move || creator.defaults()).await
}

/// Clones a repository (F-002), reporting `clone-progress` events tagged with `cloneId`.
/// Returns once the clone is complete; the caller then opens `path`. After a failure or a
/// cancellation, the folder this call created is removed.
#[tauri::command]
#[specta::specta]
pub async fn clone_repo(
    state: State<'_, AppState>,
    request: CloneRequest,
) -> Result<CloneResult, YagguiError> {
    let creator = Arc::clone(&state.creator);
    blocking(move || creator.clone_repo(&request)).await
}

/// Cancels the clone `clone_id`. Does nothing if it already finished.
#[tauri::command]
#[specta::specta]
pub async fn cancel_clone(state: State<'_, AppState>, clone_id: String) -> Result<(), YagguiError> {
    state.creator.cancel_clone(&clone_id);
    Ok(())
}

/// Initializes a repository (F-003): branch, optional `.gitignore` and README.
#[tauri::command]
#[specta::specta]
pub async fn init_repo(
    state: State<'_, AppState>,
    request: InitRequest,
) -> Result<InitResult, YagguiError> {
    let creator = Arc::clone(&state.creator);
    blocking(move || creator.init_repo(&request)).await
}
