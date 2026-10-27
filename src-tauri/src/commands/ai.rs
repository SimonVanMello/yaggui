//! AI commit messages (F-072 to F-075). Off until `aiEnabled` is set; the API key never
//! crosses the IPC boundary towards the frontend.

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::ai::{
    AiContextPreview, AiMessageRequest, AiProviderKind, AiSkill, AiStatus, AiTestResult,
    GeneratedCommitMessage, prompt, skills,
};
use crate::git::errors::YagguiError;
use crate::state::AppState;

/// Every provider with what it needs and what yaggui found (key source, `claude` path and
/// version). Never the key.
#[tauri::command]
#[specta::specta]
pub async fn ai_status(state: State<'_, AppState>) -> Result<AiStatus, YagguiError> {
    let ai = Arc::clone(&state.ai);
    let store = Arc::clone(&state.store);
    blocking(move || Ok(ai.status(&store.preferences()?))).await
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
    let ai = Arc::clone(&state.ai);
    blocking(move || ai.set_api_key(provider, &key)).await
}

/// Removes the saved API key of `provider` (the environment variable, if any, is used again).
#[tauri::command]
#[specta::specta]
pub async fn ai_clear_api_key(
    state: State<'_, AppState>,
    provider: AiProviderKind,
) -> Result<(), YagguiError> {
    let ai = Arc::clone(&state.ai);
    blocking(move || ai.clear_api_key(provider)).await
}

/// The built-in instructions, used while `customPrompt` is `null` (and shown by "Reset").
#[tauri::command]
#[specta::specta]
pub async fn ai_default_prompt() -> Result<String, YagguiError> {
    Ok(prompt::DEFAULT_PROMPT.to_owned())
}

/// Claude Code skills and custom commands of the user, of the repository when `repo_id` is
/// given, and of installed plugins, sorted by name.
#[tauri::command]
#[specta::specta]
pub async fn ai_list_skills(
    state: State<'_, AppState>,
    repo_id: Option<u32>,
) -> Result<Vec<AiSkill>, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || {
        let workdir = match repo_id {
            Some(id) => Some(repos.session(id)?.workdir.clone()),
            None => None,
        };
        Ok(skills::list(
            std::env::home_dir().as_deref(),
            workdir.as_deref(),
        ))
    })
    .await
}

/// Sends a tiny prompt (no repository data) to `provider` with the saved preferences, to check
/// the key, the binary, its login and the model. Works while the feature is off.
#[tauri::command]
#[specta::specta]
pub async fn ai_test_provider(
    state: State<'_, AppState>,
    provider: AiProviderKind,
) -> Result<AiTestResult, YagguiError> {
    let ai = Arc::clone(&state.ai);
    let store = Arc::clone(&state.store);
    blocking(move || ai.test(&store.preferences()?, provider)).await
}

/// The exact text a generation would send for `request`, without sending it. Works while the
/// feature is off.
#[tauri::command]
#[specta::specta]
pub async fn ai_preview_context(
    state: State<'_, AppState>,
    repo_id: u32,
    request: AiMessageRequest,
) -> Result<AiContextPreview, YagguiError> {
    let ai = Arc::clone(&state.ai);
    let repos = Arc::clone(&state.repos);
    let store = Arc::clone(&state.store);
    blocking(move || ai.preview(&repos, &store.preferences()?, repo_id, request)).await
}

/// Writes a commit message for the staged changes (plus HEAD's with `request.amend`) with the
/// provider of the preferences. Never commits, never writes to the repository. One
/// generation per repository at a time. Errors: `aiDisabled`, `aiNotConfigured`,
/// `nothingToCommit`, `aiBusy`, `aiAuthFailed`, `aiRateLimited`, `aiProviderUnavailable`,
/// `aiTimeout`, `aiEmptyResponse`, `aiProviderFailed`, `cancelled`.
#[tauri::command]
#[specta::specta]
pub async fn ai_generate_commit_message(
    state: State<'_, AppState>,
    repo_id: u32,
    request: AiMessageRequest,
) -> Result<GeneratedCommitMessage, YagguiError> {
    let ai = Arc::clone(&state.ai);
    let repos = Arc::clone(&state.repos);
    let store = Arc::clone(&state.store);
    blocking(move || ai.generate(&repos, &store.preferences()?, repo_id, request)).await
}

/// Cancels the generation running for `repo_id` (it then fails with `cancelled`); nothing
/// happens when none is running.
#[tauri::command]
#[specta::specta]
pub async fn ai_cancel(state: State<'_, AppState>, repo_id: u32) -> Result<(), YagguiError> {
    state.ai.cancel(repo_id);
    Ok(())
}
