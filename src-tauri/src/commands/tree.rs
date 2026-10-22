//! Tree of a commit (M7-8, F-224). Read-only, not queued; "Save as…" asks the destination
//! itself so the frontend never passes a path to write.

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use super::blocking;
use crate::git::errors::YagguiError;
use crate::git::read::tree::{TreeFile, TreeFileContent, TreePage};
use crate::state::AppState;

/// Entries `start .. start + limit` (≤ 500) of the folder `path` of `rev`, folders first
/// then by name; an empty `path` is the root. `rev` may be a branch, `HEAD` or a SHA: the
/// page carries the commit it resolved to. Errors: `revisionNotFound`, `invalidArgument`
/// (`path` is not a folder of `rev`).
#[tauri::command]
#[specta::specta]
pub async fn tree_list(
    state: State<'_, AppState>,
    repo_id: u32,
    rev: String,
    path: String,
    start: u32,
    limit: u32,
) -> Result<TreePage, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.tree_list(repo_id, &rev, &path, start, limit)).await
}

/// The file at `path` of `rev` for display: text, image, binary, LFS pointer, symbolic link
/// or submodule. A text above the render limit comes back as `tooLarge` unless `force`.
/// Errors: `revisionNotFound`, `invalidArgument` (not a file of `rev`).
#[tauri::command]
#[specta::specta]
pub async fn tree_file(
    state: State<'_, AppState>,
    repo_id: u32,
    rev: String,
    path: String,
    force: bool,
) -> Result<TreeFile, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.tree_file(repo_id, &rev, &path, force)).await
}

/// Asks where to save, then writes the version of `path` stored in `rev`. The native dialog
/// asks before replacing a file; nothing is written when the user cancels. Returns the file
/// written, `None` on cancel. Errors: `revisionNotFound`, `invalidArgument` (not a saveable
/// file of `rev`).
#[tauri::command]
#[specta::specta]
pub async fn save_tree_file(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: u32,
    rev: String,
    path: String,
    title: String,
) -> Result<Option<String>, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || {
        // Fail before the dialog when there is nothing to save.
        if let TreeFileContent::Submodule { .. } =
            repos.tree_file(repo_id, &rev, &path, false)?.content
        {
            return Err(YagguiError::invalid_argument(
                format!("\"{path}\" is a submodule: it has no file content to save."),
                format!("« {path} » est un sous-module : il n'a pas de contenu à enregistrer."),
            ));
        }
        let name = path.rsplit('/').next().unwrap_or(&path).to_owned();
        let mut dialog = app.dialog().file().set_title(title).set_file_name(name);
        if let Some(window) = app.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        let Some(picked) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let dest = picked
            .into_path()
            .map_err(|err| YagguiError::internal(err.to_string()))?;
        // The dialog already asked about replacing an existing file.
        repos.tree_save(repo_id, &rev, &path, &dest, true)?;
        Ok(Some(dest.to_string_lossy().into_owned()))
    })
    .await
}
