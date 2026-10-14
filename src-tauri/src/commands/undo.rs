//! Undo / redo of the operations of the session (M4-1). Undo and redo run on the
//! repository's `OpQueue` (`op-started` / `op-finished` with kind `undo` / `redo`) and go
//! through the Git CLI like any write; `journal-changed` tells the buttons to refresh.

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::git::errors::YagguiError;
use crate::git::ops::types::{JournalEntry, UndoState};
use crate::state::AppState;

/// Undoes the latest journaled operation not undone yet, and returns it. Errors:
/// `nothingToUndo`, `undoBlocked` (push, fetch with prune, pull), `undoDiverged` (refs or
/// files changed since), `undoWouldOverwrite` (local changes in the way),
/// `operationInProgress`, `unresolvedConflicts`.
#[tauri::command]
#[specta::specta]
pub async fn undo(state: State<'_, AppState>, repo_id: u32) -> Result<JournalEntry, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.undo(repo_id)).await
}

/// Redoes the latest undone operation, and returns it. Errors: `nothingToRedo`, then as
/// `undo`.
#[tauri::command]
#[specta::specta]
pub async fn redo(state: State<'_, AppState>, repo_id: u32) -> Result<JournalEntry, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.redo(repo_id)).await
}

/// What undo and redo would do now (labels, and why they would be refused). Refetch on
/// `journal-changed` and `refs-changed`.
#[tauri::command]
#[specta::specta]
pub async fn undo_state(
    state: State<'_, AppState>,
    repo_id: u32,
) -> Result<UndoState, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.undo_state(repo_id)).await
}

/// Operations journaled in this session, newest first (undone ones included).
#[tauri::command]
#[specta::specta]
pub async fn op_history(
    state: State<'_, AppState>,
    repo_id: u32,
) -> Result<Vec<JournalEntry>, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.op_history(repo_id)).await
}
