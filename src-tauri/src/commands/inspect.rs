//! File history, line history, blame and reflog (M4-4, M7-7). Read-only, not queued. File
//! history, line history and blame run Git walks that can take seconds on a large repository:
//! the frontend passes a `token` it chose, and `cancel_read(token)` stops the walk (error
//! `cancelled`).

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::git::errors::YagguiError;
use crate::git::read::blame::{Blame, BlameRequest};
use crate::git::read::file_history::{FileHistoryCursor, FileHistoryPage};
use crate::git::read::line_history::{LineHistoryCursor, LineHistoryPage, LineHistoryRequest};
use crate::git::read::reflog::ReflogPage;
use crate::state::AppState;

/// One page (≤ 500 entries, newest first) of the commits that changed `path`, following
/// renames like `git log --follow`. Starts at `rev` (HEAD when `None`), or continues at
/// `cursor` (the `next` of the previous page). Errors: `revisionNotFound`,
/// `invalidArgument`, `cancelled`.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn file_history(
    state: State<'_, AppState>,
    repo_id: u32,
    path: String,
    rev: Option<String>,
    cursor: Option<FileHistoryCursor>,
    limit: u32,
    token: u32,
) -> Result<FileHistoryPage, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.file_history(repo_id, &path, rev.as_deref(), cursor, limit, token)).await
}

/// One page (≤ 500 entries, fewer for wide ranges, newest first) of the commits that changed
/// the lines `request.start ..= request.end` (1-based, inclusive) of `request.path`, with the
/// diff of the range (`git log -L`): the range is followed as lines move around it and across
/// renames. Working tree line numbers (`rev: None`) are mapped to HEAD first; the page says
/// which range was followed. Continues at `cursor` (the `next` of the previous page). Errors:
/// `revisionNotFound`, `invalidArgument` (range, binary or uncommitted lines), `cancelled`.
#[tauri::command]
#[specta::specta]
pub async fn line_history(
    state: State<'_, AppState>,
    repo_id: u32,
    request: LineHistoryRequest,
    cursor: Option<LineHistoryCursor>,
    limit: u32,
    token: u32,
) -> Result<LineHistoryPage, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.line_history(repo_id, &request, cursor, limit, token)).await
}

/// Line attribution of a file at a commit, or of the working tree file (uncommitted lines
/// attributed to the null SHA). Binary files and files not in HEAD yet are not blamed (see
/// `BlameContent`). Errors: `revisionNotFound`, `invalidArgument` (not a file of `rev`),
/// `cancelled`.
#[tauri::command]
#[specta::specta]
pub async fn blame(
    state: State<'_, AppState>,
    repo_id: u32,
    request: BlameRequest,
    token: u32,
) -> Result<Blame, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.blame(repo_id, &request, token)).await
}

/// Entries `start .. start + limit` (≤ 500) of the reflog of `reference` (`HEAD`,
/// `refs/heads/…`, `refs/remotes/…`), newest first.
#[tauri::command]
#[specta::specta]
pub async fn reflog(
    state: State<'_, AppState>,
    repo_id: u32,
    reference: String,
    start: u32,
    limit: u32,
) -> Result<ReflogPage, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.reflog(repo_id, &reference, start, limit)).await
}

/// Stops the file history, line history or blame started with `token` (or the next one to start with it).
#[tauri::command]
#[specta::specta]
pub async fn cancel_read(state: State<'_, AppState>, token: u32) -> Result<(), YagguiError> {
    state.repos.cancel_read(token);
    Ok(())
}
