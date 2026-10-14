//! Commit and stash V1 (M4-7a): templates, signing, recent messages, identity profiles,
//! "Add to .gitignore" and the stash of selected files.

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::git::errors::YagguiError;
use crate::git::ops::types::{
    CommitSettings, GitignorePreview, GitignoreRuleKind, SignatureCheck, StashEntryInfo,
    StashPathsRequest,
};
use crate::state::AppState;
use crate::store::{CommitTemplate, IdentityProfile, RecentCommitMessage};

/// `commit.template` message (comment lines removed) and whether commits will be signed.
#[tauri::command]
#[specta::specta]
pub async fn commit_settings(
    state: State<'_, AppState>,
    repo_id: u32,
) -> Result<CommitSettings, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.commit_settings(repo_id)).await
}

/// Checks the signature of a commit (gpg, gpgsm or ssh-keygen, as Git is configured).
#[tauri::command]
#[specta::specta]
pub async fn verify_commit_signature(
    state: State<'_, AppState>,
    repo_id: u32,
    sha: String,
) -> Result<SignatureCheck, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.verify_signature(repo_id, &sha)).await
}

/// Messages committed from yaggui in this repository, most recent first.
#[tauri::command]
#[specta::specta]
pub async fn recent_commit_messages(
    state: State<'_, AppState>,
    repo_id: u32,
) -> Result<Vec<RecentCommitMessage>, YagguiError> {
    state.store.recent_commit_messages(repo_id)
}

#[tauri::command]
#[specta::specta]
pub async fn list_commit_templates(
    state: State<'_, AppState>,
) -> Result<Vec<CommitTemplate>, YagguiError> {
    state.store.commit_templates()
}

/// Creates (`id` of `null`) or replaces a template; names are unique.
#[tauri::command]
#[specta::specta]
pub async fn save_commit_template(
    state: State<'_, AppState>,
    template: CommitTemplate,
) -> Result<CommitTemplate, YagguiError> {
    state.store.save_commit_template(&template)
}

#[tauri::command]
#[specta::specta]
pub async fn delete_commit_template(
    state: State<'_, AppState>,
    id: u32,
) -> Result<(), YagguiError> {
    state.store.delete_commit_template(id)
}

#[tauri::command]
#[specta::specta]
pub async fn list_identity_profiles(
    state: State<'_, AppState>,
) -> Result<Vec<IdentityProfile>, YagguiError> {
    state.store.identity_profiles()
}

/// Creates (`id` of `null`) or replaces a profile. Applying one to a repository is
/// `set_git_identity` with the `repo` scope.
#[tauri::command]
#[specta::specta]
pub async fn save_identity_profile(
    state: State<'_, AppState>,
    profile: IdentityProfile,
) -> Result<IdentityProfile, YagguiError> {
    state.store.save_identity_profile(&profile)
}

#[tauri::command]
#[specta::specta]
pub async fn delete_identity_profile(
    state: State<'_, AppState>,
    id: u32,
) -> Result<(), YagguiError> {
    state.store.delete_identity_profile(id)
}

/// The rule "Add to .gitignore" would append for `path`, and the untracked files it hides.
#[tauri::command]
#[specta::specta]
pub async fn gitignore_preview(
    state: State<'_, AppState>,
    repo_id: u32,
    path: String,
    kind: GitignoreRuleKind,
) -> Result<GitignorePreview, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.gitignore_preview(repo_id, &path, kind)).await
}

/// Appends the rule to the root `.gitignore` (undoable); returns the rule. Nothing is written
/// when the line is already there.
#[tauri::command]
#[specta::specta]
pub async fn add_to_gitignore(
    state: State<'_, AppState>,
    repo_id: u32,
    path: String,
    kind: GitignoreRuleKind,
) -> Result<String, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.add_to_gitignore(repo_id, path, kind)).await
}

/// Stashes the selected files only (undoable). Error: `nothingToStash`.
#[tauri::command]
#[specta::specta]
pub async fn stash_push_paths(
    state: State<'_, AppState>,
    repo_id: u32,
    request: StashPathsRequest,
) -> Result<StashEntryInfo, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.stash_push_paths(repo_id, request)).await
}
