use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::git::cli;
use crate::git::errors::YagguiError;
use crate::state::{AppState, save_preferences};
use crate::store::{GitBinaryInfo, KnownRepo, LegacyPreferences, Preferences, TabsState};
use crate::system;

/// Known repositories (recent and favorites), most recently opened first.
#[tauri::command]
#[specta::specta]
pub async fn list_repos(state: State<'_, AppState>) -> Result<Vec<KnownRepo>, YagguiError> {
    let store = Arc::clone(&state.store);
    // `exists` stats every folder: keep it off the async threads.
    blocking(move || store.list_repos()).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_repo_favorite(
    state: State<'_, AppState>,
    repo_id: u32,
    favorite: bool,
) -> Result<(), YagguiError> {
    state.store.set_favorite(repo_id, favorite)
}

/// Removes a repository from the recent list (never touches the folder).
#[tauri::command]
#[specta::specta]
pub async fn forget_repo(state: State<'_, AppState>, repo_id: u32) -> Result<(), YagguiError> {
    state.repos.close_all(repo_id);
    state.ptys.close_repo(repo_id);
    state.store.forget_repo(repo_id)
}

/// Tabs saved at the last `save_tabs`, for restoration at startup.
#[tauri::command]
#[specta::specta]
pub async fn get_tabs(state: State<'_, AppState>) -> Result<TabsState, YagguiError> {
    state.store.tabs()
}

/// Replaces the saved tabs (order, active tab, per-tab UI state).
#[tauri::command]
#[specta::specta]
pub async fn save_tabs(state: State<'_, AppState>, tabs: TabsState) -> Result<(), YagguiError> {
    state.store.save_tabs(&tabs)
}

#[tauri::command]
#[specta::specta]
pub async fn get_preferences(state: State<'_, AppState>) -> Result<Preferences, YagguiError> {
    state.store.preferences()
}

/// Replaces the preferences and returns the stored value. A Git path that does not exist or
/// does not answer to `--version` is refused, and nothing is saved.
#[tauri::command]
#[specta::specta]
pub async fn set_preferences(
    state: State<'_, AppState>,
    preferences: Preferences,
) -> Result<Preferences, YagguiError> {
    let store = Arc::clone(&state.store);
    let git = Arc::clone(&state.git);
    blocking(move || save_preferences(&git, &store, preferences)).await
}

/// Checks a Git binary without saving it: `path` of `None` looks for the one on the system.
/// Never fails: a broken binary is reported in `error`.
#[tauri::command]
#[specta::specta]
pub async fn git_binary_info(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<GitBinaryInfo, YagguiError> {
    let git = Arc::clone(&state.git);
    blocking(move || {
        let requested = path.map(|p| p.trim().to_owned()).filter(|p| !p.is_empty());
        let resolved = match &requested {
            Some(path) => Some(PathBuf::from(path)),
            None => system::git_binary::detect(),
        };
        let min_version = cli::MIN_GIT_VERSION.to_owned();
        let Some(binary) = resolved else {
            return Ok(GitBinaryInfo {
                path: None,
                version: None,
                supported: false,
                min_version,
                error: Some(YagguiError::git_not_found()),
            });
        };
        let shown = Some(binary.display().to_string());
        Ok(match git.probe(&binary) {
            Ok(version) => GitBinaryInfo {
                supported: cli::is_supported_version(&version),
                version: Some(version),
                path: shown,
                min_version,
                error: None,
            },
            Err(error) => GitBinaryInfo {
                path: shown,
                version: None,
                supported: false,
                min_version,
                error: Some(error),
            },
        })
    })
    .await
}

/// One-shot import of the M0-1 `localStorage` preferences. Applied only on the first call
/// ever; later calls return the stored preferences unchanged.
#[tauri::command]
#[specta::specta]
pub async fn migrate_legacy_preferences(
    state: State<'_, AppState>,
    legacy: LegacyPreferences,
) -> Result<Preferences, YagguiError> {
    state.store.migrate_legacy_preferences(&legacy)
}
