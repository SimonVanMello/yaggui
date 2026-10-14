use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use super::blocking;
use crate::git::errors::YagguiError;
use crate::state::AppState;
use crate::system::terminal;

/// Opens the configured terminal (or the system default) in the repository worktree (F-266).
/// Returns the program that was started.
#[tauri::command]
#[specta::specta]
pub async fn open_terminal(
    state: State<'_, AppState>,
    repo_id: u32,
) -> Result<String, YagguiError> {
    let workdir = state.repos.session(repo_id)?.workdir.clone();
    let store = Arc::clone(&state.store);
    blocking(move || {
        let preference = store.preferences()?.terminal;
        terminal::open(&workdir, preference.as_deref())
    })
    .await
}

/// Shows the native folder picker (F-001). `None` when the user cancels.
#[tauri::command]
#[specta::specta]
pub async fn pick_repo_folder(
    app: AppHandle,
    title: String,
) -> Result<Option<String>, YagguiError> {
    blocking(move || {
        let mut dialog = app.dialog().file().set_title(title);
        if let Some(window) = app.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        // The plugin runs the dialog on the main thread; this only waits for its answer.
        let Some(picked) = dialog.blocking_pick_folder() else {
            return Ok(None);
        };
        let path: PathBuf = picked
            .into_path()
            .map_err(|err| YagguiError::internal(err.to_string()))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
}
