//! Keybindings, Git configuration editor and external tools (M4-6).

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder};

use super::blocking;
use crate::git::errors::YagguiError;
use crate::git::ops::config::{ConfigEntry, ExternalToolCheck, ExternalToolKind};
use crate::git::ops::types::ConfigScope;
use crate::state::AppState;
use crate::store::keybindings::{self, KeybindingOverride, KeybindingsFile};
use crate::store::prefs_sync::{self, AppliedImport, PreferencesImportPreview};
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

fn json_dialog(app: &AppHandle, title: String) -> FileDialogBuilder<tauri::Wry> {
    let mut dialog = app
        .dialog()
        .file()
        .set_title(title)
        .add_filter("JSON", &["json"]);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog
}

/// Asks where to save, then writes the preferences and shortcuts file (F-326). Returns the
/// file written, `None` when the user cancels.
#[tauri::command]
#[specta::specta]
pub async fn export_preferences(
    app: AppHandle,
    state: State<'_, AppState>,
    title: String,
) -> Result<Option<String>, YagguiError> {
    let store = Arc::clone(&state.store);
    let dir = state.config_dir.clone();
    blocking(move || {
        let dialog = json_dialog(&app, title).set_file_name("yaggui-preferences.json");
        let Some(picked) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let path = picked
            .into_path()
            .map_err(|err| YagguiError::internal(err.to_string()))?;
        prefs_sync::export_to(&path, &store, &dir)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
}

/// Asks for a preferences file and lists what importing it would change, without changing
/// anything. `None` when the user cancels.
#[tauri::command]
#[specta::specta]
pub async fn preview_preferences_import(
    app: AppHandle,
    state: State<'_, AppState>,
    title: String,
) -> Result<Option<PreferencesImportPreview>, YagguiError> {
    let store = Arc::clone(&state.store);
    let dir = state.config_dir.clone();
    blocking(move || {
        let Some(picked) = json_dialog(&app, title).blocking_pick_file() else {
            return Ok(None);
        };
        let path = picked
            .into_path()
            .map_err(|err| YagguiError::internal(err.to_string()))?;
        prefs_sync::preview_from(&path, &store, &dir).map(Some)
    })
    .await
}

/// Applies the file a preview was made from, in one step. The file is validated again.
#[tauri::command]
#[specta::specta]
pub async fn apply_preferences_import(
    state: State<'_, AppState>,
    path: String,
) -> Result<AppliedImport, YagguiError> {
    let store = Arc::clone(&state.store);
    let dir = state.config_dir.clone();
    blocking(move || prefs_sync::apply_from(std::path::Path::new(&path), &store, &dir)).await
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
