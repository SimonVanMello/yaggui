//! Merge, rebase, cherry-pick, revert, reset, the operation in progress and its conflicts
//! (M3-1). Writes run on the repository's `OpQueue` (`op-started` / `op-finished`); each
//! command resolves once its operation is done. An operation that stops on conflicts fails
//! with `conflicts` and stays in progress (`repo_state().operation`, `status-changed`).

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::git::errors::YagguiError;
use crate::git::ops::types::{
    AutosquashPlan, CherryPickRequest, CommitResult, ConflictList, ConflictResolution,
    ConflictStage, ConflictVersions, HistoryResult, InteractiveRebasePlan, InteractiveRebaseResult,
    MergeRequest, MergeToolResult, OperationDetail, RebaseRequest, RebaseTodoEntry, ResetPreview,
    ResetRequest, ResetResult, RevertRequest,
};
use crate::state::AppState;

/// Merges a branch or commit into the current branch, in the given mode. Errors:
/// `conflicts`, `notFastForward` (`fastForwardOnly`), `dirtyWorktree`,
/// `unresolvedConflicts`, `operationInProgress`. Cancellable (hooks).
#[tauri::command]
#[specta::specta]
pub async fn merge(
    state: State<'_, AppState>,
    repo_id: u32,
    request: MergeRequest,
) -> Result<HistoryResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.merge(repo_id, request)).await
}

/// Rebases a branch onto another (non-interactive). Progress: `op-progress` with phase
/// `Rebasing` and `current` / `total`. Errors: `conflicts`, `dirtyWorktree`. Cancellable.
#[tauri::command]
#[specta::specta]
pub async fn rebase(
    state: State<'_, AppState>,
    repo_id: u32,
    request: RebaseRequest,
) -> Result<HistoryResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.rebase(repo_id, request)).await
}

/// Applies commits on HEAD, oldest first. Errors: `conflicts`, `emptyCommit` (stopped, in
/// progress), `mainlineRequired`, `dirtyWorktree`. Cancellable.
#[tauri::command]
#[specta::specta]
pub async fn cherry_pick(
    state: State<'_, AppState>,
    repo_id: u32,
    request: CherryPickRequest,
) -> Result<HistoryResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.cherry_pick(repo_id, request)).await
}

/// Creates a commit undoing another one (a merge: relative to the chosen parent).
/// Errors: `conflicts`, `emptyCommit`, `mainlineRequired`, `dirtyWorktree`. Cancellable.
#[tauri::command]
#[specta::specta]
pub async fn revert(
    state: State<'_, AppState>,
    repo_id: u32,
    request: RevertRequest,
) -> Result<HistoryResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.revert(repo_id, request)).await
}

/// What resetting the current branch to `target` would do (commits, files a hard reset
/// loses). Read-only, not queued.
#[tauri::command]
#[specta::specta]
pub async fn reset_preview(
    state: State<'_, AppState>,
    repo_id: u32,
    target: String,
) -> Result<ResetPreview, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.reset_preview(repo_id, &target)).await
}

/// Moves the current branch (or detached HEAD) to a commit. A hard reset first saves the
/// files it overwrites (`backupId`), like a discard.
#[tauri::command]
#[specta::specta]
pub async fn reset(
    state: State<'_, AppState>,
    repo_id: u32,
    request: ResetRequest,
) -> Result<ResetResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.reset(repo_id, request)).await
}

/// The operation in progress with its labels and prepared message; `None` when there is
/// none. Read-only.
#[tauri::command]
#[specta::specta]
pub async fn operation_detail(
    state: State<'_, AppState>,
    repo_id: u32,
) -> Result<Option<OperationDetail>, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.operation_detail(repo_id)).await
}

/// Continues the operation in progress once its conflicts are resolved. `message` replaces
/// the prepared message of the commit it creates (`None`: keep it). Errors: `conflicts`
/// (stopped again, next step), `unresolvedConflicts`, `emptyCommit`, `noOperation`.
#[tauri::command]
#[specta::specta]
pub async fn continue_operation(
    state: State<'_, AppState>,
    repo_id: u32,
    message: Option<String>,
) -> Result<HistoryResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.continue_operation(repo_id, message)).await
}

/// Skips the commit the operation stopped on (rebase, cherry-pick, revert, mailbox) or the
/// commit to test (bisect), then goes on. Errors as `continue_operation`.
#[tauri::command]
#[specta::specta]
pub async fn skip_operation(
    state: State<'_, AppState>,
    repo_id: u32,
) -> Result<HistoryResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.skip_operation(repo_id)).await
}

/// Aborts the operation in progress: HEAD, index and working tree go back to how they were
/// before it (`bisect reset` for a bisect). Error: `noOperation`.
#[tauri::command]
#[specta::specta]
pub async fn abort_operation(state: State<'_, AppState>, repo_id: u32) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.abort_operation(repo_id)).await
}

/// Conflicted files (resolved ones included while the operation is in progress) and the
/// labels of their sides. Read-only.
#[tauri::command]
#[specta::specta]
pub async fn list_conflicts(
    state: State<'_, AppState>,
    repo_id: u32,
) -> Result<ConflictList, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.list_conflicts(repo_id)).await
}

/// Resolves conflicted files with one side, the working tree as is, or given content.
/// Error: `invalidArgument` for a path not in conflict.
#[tauri::command]
#[specta::specta]
pub async fn resolve_conflicts(
    state: State<'_, AppState>,
    repo_id: u32,
    paths: Vec<String>,
    resolution: ConflictResolution,
) -> Result<(), YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.resolve_conflicts(repo_id, paths, resolution)).await
}

/// Base, ours, theirs and working tree versions of a conflicted file, with the labels to
/// show (3-way editor, M3-3). Read-only.
#[tauri::command]
#[specta::specta]
pub async fn conflict_versions(
    state: State<'_, AppState>,
    repo_id: u32,
    path: String,
) -> Result<ConflictVersions, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.conflict_versions(repo_id, &path)).await
}

/// One stage of a conflicted image as a `data:` URL, for the binary conflict view (F-165);
/// `None` when the file is not an image, the stage is absent or too large. Read-only.
#[tauri::command]
#[specta::specta]
pub async fn conflict_image(
    state: State<'_, AppState>,
    repo_id: u32,
    path: String,
    stage: ConflictStage,
) -> Result<Option<String>, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.conflict_image(repo_id, &path, stage)).await
}

/// External merge tool configured in Git (`merge.tool`), `None` when there is none.
/// Read-only.
#[tauri::command]
#[specta::specta]
pub async fn merge_tool(
    state: State<'_, AppState>,
    repo_id: u32,
) -> Result<Option<String>, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.merge_tool(repo_id)).await
}

/// Opens a conflicted file in the configured merge tool (`git mergetool --tool=<merge.tool>`)
/// and resolves once the tool is closed (F-164). Errors: `mergeToolMissing`,
/// `mergeToolFailed`, `invalidArgument` (not in conflict). Cancellable (closes the tool).
#[tauri::command]
#[specta::specta]
pub async fn run_merge_tool(
    state: State<'_, AppState>,
    repo_id: u32,
    path: String,
) -> Result<MergeToolResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.run_merge_tool(repo_id, path)).await
}

/// The commits of `base..HEAD` an interactive rebase would rewrite, oldest first, with the
/// ones already on the upstream and whether merges forbid it. Read-only. Errors:
/// `detachedHead`, `revisionNotFound`, `invalidArgument` (base not an ancestor of HEAD, more
/// than `REBASE_PLAN_MAX` commits).
#[tauri::command]
#[specta::specta]
pub async fn interactive_rebase_plan(
    state: State<'_, AppState>,
    repo_id: u32,
    base: String,
) -> Result<InteractiveRebasePlan, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.interactive_rebase_plan(repo_id, &base)).await
}

/// Rewrites `base..HEAD` following `todo` (every commit of the plan once, in the new order,
/// oldest first). Never opens an editor: reword and squash messages come with the todo.
/// Stopping on an `edit` step succeeds with `stopped`; on conflicts it fails with
/// `conflicts`. Both leave the rebase in progress: `continueOperation` / `skipOperation` /
/// `abortOperation`. Progress: `op-progress` (`Rebasing`, n/m). Errors: `dirtyWorktree`,
/// `operationInProgress`, `unresolvedConflicts`, `detachedHead`, `invalidArgument` (merges
/// in the range, stale or invalid todo). Cancellable.
#[tauri::command]
#[specta::specta]
pub async fn interactive_rebase(
    state: State<'_, AppState>,
    repo_id: u32,
    base: String,
    todo: Vec<RebaseTodoEntry>,
) -> Result<InteractiveRebaseResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.interactive_rebase(repo_id, base, todo)).await
}

/// Gives a commit a new message (summary, blank line, body). HEAD is amended without its
/// staged changes; an older commit of the current branch is reworded by an interactive
/// rebase, the commits after it replayed unchanged. Returns the new SHA of that commit.
/// Errors: `invalidArgument` (empty summary, commit not on the current branch, root commit
/// that is not HEAD, merges after it), `dirtyWorktree`, `operationInProgress`,
/// `detachedHead` (older commit). Cancellable.
#[tauri::command]
#[specta::specta]
pub async fn reword_commit(
    state: State<'_, AppState>,
    repo_id: u32,
    sha: String,
    message: String,
) -> Result<CommitResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.reword_commit(repo_id, sha, message)).await
}

/// Commits the staged changes as `fixup! <subject of target>` (`git commit --fixup`), hooks
/// included; journaled and undoable like a commit (F-147). Errors: `nothingToCommit`,
/// `hookFailed`, `identityUnknown`, `revisionNotFound`, `invalidArgument` (commit not on
/// the current branch). Cancellable.
#[tauri::command]
#[specta::specta]
pub async fn commit_fixup(
    state: State<'_, AppState>,
    repo_id: u32,
    target: String,
) -> Result<CommitResult, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.commit_fixup(repo_id, target)).await
}

/// The plan of `base..HEAD` with its `fixup!` commits moved under their targets, for the
/// interactive rebase view (F-147). Without `base`: from the parent of the oldest commit a
/// fixup of the current branch targets (first parents from HEAD, up to the first merge),
/// `None` when no fixup has a target. Read-only. Errors: as `interactiveRebasePlan`.
#[tauri::command]
#[specta::specta]
pub async fn autosquash_plan(
    state: State<'_, AppState>,
    repo_id: u32,
    base: Option<String>,
) -> Result<Option<AutosquashPlan>, YagguiError> {
    let repos = Arc::clone(&state.repos);
    blocking(move || repos.autosquash_plan(repo_id, base)).await
}
