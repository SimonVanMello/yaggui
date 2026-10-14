use tauri::State;

use crate::git::errors::YagguiError;
use crate::git::log::CommandLogEntry;
use crate::state::AppState;

/// Executed Git commands, oldest first (bounded in memory).
#[tauri::command]
#[specta::specta]
pub async fn command_log(state: State<'_, AppState>) -> Result<Vec<CommandLogEntry>, YagguiError> {
    Ok(state.git.log().entries())
}

#[tauri::command]
#[specta::specta]
pub async fn clear_command_log(state: State<'_, AppState>) -> Result<(), YagguiError> {
    state.git.log().clear();
    Ok(())
}
