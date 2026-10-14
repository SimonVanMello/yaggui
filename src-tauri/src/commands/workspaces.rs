//! Workspaces (F-006 to F-009): named groups of repos, their overview and fetch, folder scans,
//! relocation of a moved repo.

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::git::errors::YagguiError;
use crate::repo::scan::{ScanRequest, ScanResult};
use crate::repo::workspace::{ImportResult, RepoOverview};
use crate::state::AppState;
use crate::store::{KnownRepo, Workspace};

/// Workspaces sorted by name, each with its repo ids in display order.
#[tauri::command]
#[specta::specta]
pub async fn list_workspaces(state: State<'_, AppState>) -> Result<Vec<Workspace>, YagguiError> {
    state.store.list_workspaces()
}

/// Names are trimmed and unique (case-insensitive). Unknown repo ids are ignored.
#[tauri::command]
#[specta::specta]
pub async fn create_workspace(
    state: State<'_, AppState>,
    name: String,
    repo_ids: Vec<u32>,
) -> Result<Workspace, YagguiError> {
    state.store.create_workspace(&name, &repo_ids)
}

#[tauri::command]
#[specta::specta]
pub async fn rename_workspace(
    state: State<'_, AppState>,
    workspace_id: u32,
    name: String,
) -> Result<Workspace, YagguiError> {
    state.store.rename_workspace(workspace_id, &name)
}

/// Deletes the workspace only: its repos stay in the known repos.
#[tauri::command]
#[specta::specta]
pub async fn delete_workspace(
    state: State<'_, AppState>,
    workspace_id: u32,
) -> Result<(), YagguiError> {
    state.store.delete_workspace(workspace_id)
}

/// Appends known repos to the workspace (those already in it keep their place).
#[tauri::command]
#[specta::specta]
pub async fn add_to_workspace(
    state: State<'_, AppState>,
    workspace_id: u32,
    repo_ids: Vec<u32>,
) -> Result<Workspace, YagguiError> {
    state.store.add_to_workspace(workspace_id, &repo_ids)
}

#[tauri::command]
#[specta::specta]
pub async fn remove_from_workspace(
    state: State<'_, AppState>,
    workspace_id: u32,
    repo_id: u32,
) -> Result<Workspace, YagguiError> {
    state.store.remove_from_workspace(workspace_id, repo_id)
}

/// Branch, ahead / behind, dirty counts and last fetch of a known repo, open or not (F-008).
/// Missing folders and unreadable repos are reported in the result. At most 4 reads run at
/// once, whatever the number of calls.
#[tauri::command]
#[specta::specta]
pub async fn repo_overview(
    state: State<'_, AppState>,
    repo_id: u32,
) -> Result<RepoOverview, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.repo_overview(repo_id)).await
}

/// `git fetch --all` of a known repo, open or not, on its queue (`op-started` /
/// `op-finished`, cancellable with `cancel_op`). At most 4 run at once.
#[tauri::command]
#[specta::specta]
pub async fn fetch_known_repo(
    state: State<'_, AppState>,
    repo_id: u32,
    prune: bool,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.fetch_known(repo_id, prune)).await
}

/// Lists the repositories under `root` (F-007), reporting `scan-progress` events tagged with
/// `scanId`. Errors: `cancelled`, `repoNotFound`, `invalidArgument`.
#[tauri::command]
#[specta::specta]
pub async fn scan_folder(
    state: State<'_, AppState>,
    request: ScanRequest,
) -> Result<ScanResult, YagguiError> {
    let scanner = Arc::clone(&state.scanner);
    blocking(move || scanner.scan(&request)).await
}

/// Cancels the scan `scan_id`. Does nothing if it already finished.
#[tauri::command]
#[specta::specta]
pub async fn cancel_scan(state: State<'_, AppState>, scan_id: String) -> Result<(), YagguiError> {
    state.scanner.cancel(&scan_id);
    Ok(())
}

/// Adds worktree roots to the known repos (not marked as opened), and to a workspace if given.
#[tauri::command]
#[specta::specta]
pub async fn import_repos(
    state: State<'_, AppState>,
    paths: Vec<String>,
    workspace_id: Option<u32>,
) -> Result<ImportResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.import_repos(&paths, workspace_id)).await
}

/// Points a moved repo to its new folder (F-009). If that folder was already known, both
/// entries are merged and the returned repo has the other id.
#[tauri::command]
#[specta::specta]
pub async fn relocate_repo(
    state: State<'_, AppState>,
    repo_id: u32,
    path: String,
) -> Result<KnownRepo, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.relocate_repo(repo_id, &path)).await
}
