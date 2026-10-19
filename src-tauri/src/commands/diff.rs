use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::git::errors::YagguiError;
use crate::git::read::diff::{
    self,
    edit::WorktreeFile,
    types::{ChangedFiles, DiffOptions, DiffTarget, FileDiff},
};
use crate::state::AppState;

/// Changed files of a commit (or between two commits), of the index or of the working
/// tree, with status, rename/copy similarity and line stats.
#[tauri::command]
#[specta::specta]
pub async fn changed_files(
    state: State<'_, AppState>,
    repo_id: u32,
    target: DiffTarget,
) -> Result<ChangedFiles, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.changed_files(repo_id, &target)).await
}

/// Diff of one file of `target`. `old_path` is the source of a rename or copy.
#[tauri::command]
#[specta::specta]
pub async fn file_diff(
    state: State<'_, AppState>,
    repo_id: u32,
    target: DiffTarget,
    path: String,
    old_path: Option<String>,
    options: DiffOptions,
) -> Result<FileDiff, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || {
        let repo = repos.session(repo_id)?.repo()?.to_thread_local();
        diff::file_diff(&repo, &target, &path, old_path.as_deref(), &options)
    })
    .await
}

/// Working tree content of an unstaged text file and its index version, for the diff view's
/// editor. Refused for files it could not write back as they are (binary, not UTF-8, mixed
/// line endings, LFS, symlinks).
#[tauri::command]
#[specta::specta]
pub async fn worktree_file(
    state: State<'_, AppState>,
    repo_id: u32,
    path: String,
) -> Result<WorktreeFile, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || {
        let repo = repos.session(repo_id)?.repo()?.to_thread_local();
        diff::edit::read(&repo, &path)
    })
    .await
}
