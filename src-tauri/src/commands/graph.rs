use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::git::errors::YagguiError;
use crate::git::read::refs::RepoRefs;
use crate::graph::types::{CommitDetail, CommitSearch, GraphLocation, GraphPage, SearchChunk};
use crate::state::AppState;

/// Rows `start .. start + limit` of the commit graph (`limit` ≤ 500). Past the end, the page
/// is empty. The first call after a refs change recomputes the history order.
#[tauri::command]
#[specta::specta]
pub async fn graph_page(
    state: State<'_, AppState>,
    repo_id: u32,
    start: u32,
    limit: u32,
) -> Result<GraphPage, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.graph_page(repo_id, start, limit)).await
}

/// Row of a revision (full or abbreviated SHA, branch, tag, `HEAD~2`…), to jump to a commit
/// even outside the loaded pages.
#[tauri::command]
#[specta::specta]
pub async fn graph_index_of(
    state: State<'_, AppState>,
    repo_id: u32,
    rev: String,
) -> Result<GraphLocation, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.graph_index_of(repo_id, &rev)).await
}

/// Searches the graph from `from_row` for a short time budget; see `SearchChunk`.
#[tauri::command]
#[specta::specta]
pub async fn search_commits(
    state: State<'_, AppState>,
    repo_id: u32,
    query: CommitSearch,
    from_row: u32,
) -> Result<SearchChunk, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.search_commits(repo_id, &query, from_row)).await
}

/// Header data of a commit (message, author, committer, refs, signature).
#[tauri::command]
#[specta::specta]
pub async fn commit_detail(
    state: State<'_, AppState>,
    repo_id: u32,
    sha: String,
) -> Result<CommitDetail, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.commit_detail(repo_id, &sha)).await
}

/// Branches, remotes, tags, stashes, submodules and worktrees for the sidebar.
#[tauri::command]
#[specta::specta]
pub async fn list_refs(state: State<'_, AppState>, repo_id: u32) -> Result<RepoRefs, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.list_refs(repo_id)).await
}
