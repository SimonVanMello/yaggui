//! Keybindings, Git configuration editor and external tools (M4-6).

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::git::errors::YagguiError;
use crate::git::ops::config::{ConfigEntry, ExternalToolCheck, ExternalToolKind};
use crate::git::ops::types::ConfigScope;
use crate::state::AppState;
use crate::store::keybindings::{self, KeybindingOverride, KeybindingsFile};
use crate::system::editor;

/// The shortcuts the user changed, from `keybindings.json` (F-281).
#[tauri::command]
#[specta::specta]
pub async fn get_keybindings(state: State<'_, AppState>) -> Result<KeybindingsFile, YagguiError> {
    let dir = state.config_dir.clone();
    blocking(move || Ok(keybindings::read(&dir))).await
}

/// Replaces `keybindings.json` with these overrides and returns what was written.
#[tauri::command]
#[specta::specta]
pub async fn set_keybindings(
    state: State<'_, AppState>,
    overrides: Vec<KeybindingOverride>,
) -> Result<KeybindingsFile, YagguiError> {
    let dir = state.config_dir.clone();
    blocking(move || keybindings::write(&dir, &overrides)).await
}

/// Entries of the global or local Git config file (F-325). `repo_id` is required for the
/// repository scope.
#[tauri::command]
#[specta::specta]
pub async fn git_config_list(
    state: State<'_, AppState>,
    repo_id: Option<u32>,
    scope: ConfigScope,
) -> Result<Vec<ConfigEntry>, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.git_config_list(repo_id, scope)).await
}

/// Sets a Git config key, or removes it when `value` is `None` (`git config` on the queue).
#[tauri::command]
#[specta::specta]
pub async fn git_config_set(
    state: State<'_, AppState>,
    repo_id: Option<u32>,
    scope: ConfigScope,
    key: String,
    value: Option<String>,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.git_config_set(repo_id, scope, key, value)).await
}

/// Tests an external tool (F-323): an editor or terminal is started, a diff or merge tool is
/// looked up in Git. `name` is the value being edited; `None` tests the saved one.
#[tauri::command]
#[specta::specta]
pub async fn check_external_tool(
    state: State<'_, AppState>,
    kind: ExternalToolKind,
    name: Option<String>,
    repo_id: Option<u32>,
) -> Result<ExternalToolCheck, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.check_external_tool(kind, name, repo_id)).await
}

/// Opens the repository (or a file of it, `path` relative to the worktree) in the external
/// editor. Returns the program that was started.
#[tauri::command]
#[specta::specta]
pub async fn open_in_editor(
    state: State<'_, AppState>,
    repo_id: u32,
    path: Option<String>,
) -> Result<String, YagguiError> {
    let repos = Arc::clone(&state.repos);
    let store = Arc::clone(&state.store);
    blocking(move || {
        let target = repos.editor_target(repo_id, path)?;
        editor::open(&target, store.preferences()?.editor.as_deref())
    })
    .await
}
