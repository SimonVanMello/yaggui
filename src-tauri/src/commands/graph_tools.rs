//! Graph, diff and branch tools (M4-7b): graph filter, merge-base, comparison, image diff,
//! external diff tool, file manager, branch cleanup.

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::git::errors::YagguiError;
use crate::git::ops::types::{BranchCleanup, DeleteBranchesResult};
use crate::git::read::diff::types::{DiffSide, DiffTarget};
use crate::graph::types::{Comparison, GraphFilter, GraphLocation};
use crate::state::AppState;
use crate::system::editor;

/// Refs hidden from the graph of a repository, or soloed (F-028). Read-only.
#[tauri::command]
#[specta::specta]
pub async fn graph_filter(
    state: State<'_, AppState>,
    repo_id: u32,
) -> Result<GraphFilter, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.graph_filter(repo_id)).await
}

/// Stores and applies the graph filter of a repository (persisted per repository). The
/// graph version changes: reload the pages. Returns the filter as stored.
#[tauri::command]
#[specta::specta]
pub async fn set_graph_filter(
    state: State<'_, AppState>,
    repo_id: u32,
    filter: GraphFilter,
) -> Result<GraphFilter, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.set_graph_filter(repo_id, filter)).await
}

/// Best common ancestor of two revisions and its row (F-030); `None` for unrelated
/// histories. Read-only.
#[tauri::command]
#[specta::specta]
pub async fn merge_base(
    state: State<'_, AppState>,
    repo_id: u32,
    a: String,
    b: String,
) -> Result<Option<GraphLocation>, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.merge_base(repo_id, &a, &b)).await
}

/// Commits of `a` not in `b` and the reverse, with the merge-base (F-104). The global diff
/// is `changed_files` / `file_diff` on `DiffTarget::Commits { from: b, to: a }`. Read-only.
#[tauri::command]
#[specta::specta]
pub async fn compare_revisions(
    state: State<'_, AppState>,
    repo_id: u32,
    a: String,
    b: String,
) -> Result<Comparison, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.compare(repo_id, &a, &b)).await
}

/// One side of an image of `target` as a `data:` URL (F-085); `None` when not an image the
/// webview shows, absent, or too large. Read-only.
#[tauri::command]
#[specta::specta]
pub async fn diff_image(
    state: State<'_, AppState>,
    repo_id: u32,
    target: DiffTarget,
    path: String,
    old_path: Option<String>,
    side: DiffSide,
) -> Result<Option<String>, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.diff_image(repo_id, &target, &path, old_path.as_deref(), side)).await
}

/// Opens one file of `target` in the external diff tool (`git difftool`, F-087) and resolves
/// when the tool is closed, with the tool's name. Errors: `diffToolMissing`, `diffToolFailed`.
#[tauri::command]
#[specta::specta]
pub async fn run_diff_tool(
    state: State<'_, AppState>,
    repo_id: u32,
    target: DiffTarget,
    path: String,
    old_path: Option<String>,
) -> Result<String, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.run_diff_tool(repo_id, &target, &path, old_path.as_deref())).await
}

/// Shows a file of the working tree in the file manager (F-087). Without `path`, opens the
/// repository folder itself (toolbar button), not selected in its parent: `fileManagerFailed`.
#[tauri::command]
#[specta::specta]
pub async fn reveal_path(
    state: State<'_, AppState>,
    repo_id: u32,
    path: Option<String>,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || match path {
        None => editor::open_folder(&repos.editor_target(repo_id, None)?),
        Some(path) => editor::reveal(&repos.editor_target(repo_id, Some(path))?),
    })
    .await
}

/// Local branches merged into HEAD or whose upstream is gone (F-105), without the current,
/// checked out and protected ones (listed apart). Read-only.
#[tauri::command]
#[specta::specta]
pub async fn branch_cleanup(
    state: State<'_, AppState>,
    repo_id: u32,
) -> Result<BranchCleanup, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.branch_cleanup(repo_id)).await
}

/// Deletes local branches (never their remote branch) in one journaled operation (undo
/// restores them all). Refuses the whole batch if one is current, checked out elsewhere or
/// protected: `currentBranch`, `branchCheckedOut`, `protectedBranchDelete`.
#[tauri::command]
#[specta::specta]
pub async fn delete_branches(
    state: State<'_, AppState>,
    repo_id: u32,
    names: Vec<String>,
) -> Result<DeleteBranchesResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.delete_branches(repo_id, names)).await
}
