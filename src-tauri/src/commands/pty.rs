use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::git::errors::YagguiError;
use crate::state::AppState;
use crate::system::pty::{PtyInfo, PtyKind};

/// Starts the user's shell in the repository folder, in an integrated terminal of
/// `cols`×`rows` cells (F-267). Its output arrives as `pty-output` events, then `pty-exited`.
#[tauri::command]
#[specta::specta]
pub async fn pty_spawn(
    state: State<'_, AppState>,
    repo_id: u32,
    cols: u16,
    rows: u16,
) -> Result<PtyInfo, YagguiError> {
    let workdir = state.repos.session(repo_id)?.workdir.clone();
    let ptys = Arc::clone(&state.ptys);
    blocking(move || ptys.spawn(repo_id, &workdir, cols, rows)).await
}

/// Sends keyboard input or pasted text to an integrated terminal. `kind` is what the caller
/// believes the terminal runs (a shell, or the package manager of an upgrade): a mismatch is
/// refused.
#[tauri::command]
#[specta::specta]
pub async fn pty_write(
    state: State<'_, AppState>,
    pty_id: u32,
    kind: PtyKind,
    data: String,
) -> Result<(), YagguiError> {
    let ptys = Arc::clone(&state.ptys);
    blocking(move || ptys.write(pty_id, kind, &data)).await
}

/// New size of an integrated terminal, in cells.
#[tauri::command]
#[specta::specta]
pub async fn pty_resize(
    state: State<'_, AppState>,
    pty_id: u32,
    kind: PtyKind,
    cols: u16,
    rows: u16,
) -> Result<(), YagguiError> {
    let ptys = Arc::clone(&state.ptys);
    blocking(move || ptys.resize(pty_id, kind, cols, rows)).await
}

/// Ends an integrated terminal and its shell. No-op if it already exited.
#[tauri::command]
#[specta::specta]
pub async fn pty_close(
    state: State<'_, AppState>,
    pty_id: u32,
    kind: PtyKind,
) -> Result<(), YagguiError> {
    let ptys = Arc::clone(&state.ptys);
    blocking(move || {
        ptys.close(pty_id, kind);
        Ok(())
    })
    .await
}
