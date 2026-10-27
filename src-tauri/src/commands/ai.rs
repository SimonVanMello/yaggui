//! AI commit messages (F-072 to F-075). Off until `aiEnabled` is set; the API key never
//! crosses the IPC boundary towards the frontend.

use tauri::State;

use crate::ai::{
    AiContextPreview, AiProviderKind, AiSkill, AiStatus, AiTestResult, GeneratedCommitMessage,
};
use crate::git::errors::YagguiError;
use crate::state::AppState;

/// Every provider with what it needs and what yaggui found (key source, `claude` path and
/// version). Never the key.
#[tauri::command]
#[specta::specta]
pub async fn ai_status(state: State<'_, AppState>) -> Result<AiStatus, YagguiError> {
    let _ = state;
    Err(YagguiError::not_implemented())
}

/// Saves the API key of `provider` in the OS keychain. Errors: `invalidArgument` (empty or
/// malformed key, provider without key), `aiKeychainUnavailable`.
#[tauri::command]
#[specta::specta]
pub async fn ai_set_api_key(
    state: State<'_, AppState>,
    provider: AiProviderKind,
    key: String,
) -> Result<(), YagguiError> {
    let _ = (state, provider, key);
    Err(YagguiError::not_implemented())
}

/// Removes the saved API key of `provider` (the environment variable, if any, is used again).
#[tauri::command]
#[specta::specta]
pub async fn ai_clear_api_key(
    state: State<'_, AppState>,
    provider: AiProviderKind,
) -> Result<(), YagguiError> {
    let _ = (state, provider);
    Err(YagguiError::not_implemented())
}

/// The built-in instructions, used while `customPrompt` is `null` (and shown by "Reset").
#[tauri::command]
#[specta::specta]
pub async fn ai_default_prompt() -> Result<String, YagguiError> {
    Err(YagguiError::not_implemented())
}

/// Claude Code skills and custom commands of the user, of the repository when `repo_id` is
/// given, and of installed plugins, sorted by name.
#[tauri::command]
#[specta::specta]
pub async fn ai_list_skills(
    state: State<'_, AppState>,
    repo_id: Option<u32>,
) -> Result<Vec<AiSkill>, YagguiError> {
    let _ = (state, repo_id);
    Err(YagguiError::not_implemented())
}

/// Sends a tiny prompt (no repository data) to `provider` with the saved preferences, to check
/// the key, the binary, its login and the model. Works while the feature is off.
#[tauri::command]
#[specta::specta]
pub async fn ai_test_provider(
    state: State<'_, AppState>,
    provider: AiProviderKind,
) -> Result<AiTestResult, YagguiError> {
    let _ = (state, provider);
    Err(YagguiError::not_implemented())
}

/// The exact text a generation would send for the staged changes (and the amended commit's
/// with `amend`), without sending it. Works while the feature is off.
#[tauri::command]
#[specta::specta]
pub async fn ai_preview_context(
    state: State<'_, AppState>,
    repo_id: u32,
    amend: bool,
) -> Result<AiContextPreview, YagguiError> {
    let _ = (state, repo_id, amend);
    Err(YagguiError::not_implemented())
}

/// Writes a commit message for the staged changes (plus HEAD's with `amend`) with the
/// provider of the preferences. Never commits, never writes to the repository. One
/// generation per repository at a time. Errors: `aiDisabled`, `aiNotConfigured`,
/// `nothingToCommit`, `aiBusy`, `aiAuthFailed`, `aiRateLimited`, `aiProviderUnavailable`,
/// `aiTimeout`, `aiEmptyResponse`, `aiProviderFailed`, `cancelled`.
#[tauri::command]
#[specta::specta]
pub async fn ai_generate_commit_message(
    state: State<'_, AppState>,
    repo_id: u32,
    amend: bool,
) -> Result<GeneratedCommitMessage, YagguiError> {
    let _ = (state, repo_id, amend);
    Err(YagguiError::not_implemented())
}

/// Cancels the generation running for `repo_id` (it then fails with `cancelled`); nothing
/// happens when none is running.
#[tauri::command]
#[specta::specta]
pub async fn ai_cancel(state: State<'_, AppState>, repo_id: u32) -> Result<(), YagguiError> {
    let _ = (state, repo_id);
    Err(YagguiError::not_implemented())
}
