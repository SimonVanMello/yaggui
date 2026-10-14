//! Typed events pushed to the frontend. Names are derived by tauri-specta (`OpProgress` → `op-progress`).

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::git::errors::YagguiError;
use crate::git::log::CommandLogEntry;

/// Family of a queued write operation, used for labels and tab indicators.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum OpKind {
    Fetch,
    Pull,
    Push,
    Checkout,
    Commit,
    /// Stage or unstage files, hunks or lines.
    Stage,
    /// Discard working tree (and optionally staged) changes, after a backup.
    Discard,
    Stash,
    /// Create, rename or delete a branch, or change its upstream.
    Branch,
    /// Create or delete a tag.
    Tag,
    /// Add, rename or remove a remote, or change its URLs.
    Remote,
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Reset,
    /// Continue, skip or abort of a `git bisect` (bisect reset).
    Bisect,
    /// Continue, skip or abort of a `git am` stopped on a patch.
    ApplyMailbox,
    /// External merge tool (`git mergetool`) on a conflicted file.
    MergeTool,
    /// Repository maintenance (remove a lock, config change…).
    Maintenance,
    /// Initialize or update submodules.
    Submodule,
    /// Add, remove or prune worktrees.
    Worktree,
    /// Git LFS: download the objects of the checkout, track a pattern.
    Lfs,
    /// Edit of the Git configuration from the preferences (F-325); not tied to a repository
    /// when the scope is global (`repo_id` 0).
    Config,
    /// Background write of the commit-graph; silent in the UI, reloads the graph when done.
    CommitGraph,
    /// Undo of a journaled operation.
    Undo,
    /// Redo of an undone operation.
    Redo,
}

/// A Git command finished (successfully or not) and was added to the command log.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct CommandLogged {
    pub entry: CommandLogEntry,
}

/// A write operation left the queue and started running.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct OpStarted {
    pub repo_id: u32,
    pub op_id: u32,
    pub kind: OpKind,
    /// Whether `cancel_op` has an effect on this operation.
    pub cancellable: bool,
}

/// Progress of a running operation, parsed from `git --progress` output.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct OpProgress {
    pub repo_id: u32,
    pub op_id: u32,
    /// Git phase as printed by Git, e.g. `Receiving objects` (not translated).
    pub phase: String,
    /// 0–100 when Git reports a percentage.
    pub percent: Option<u8>,
    pub current: Option<u32>,
    pub total: Option<u32>,
    /// Bytes transferred so far (network phases). `f64` on the wire: specta refuses `u64`.
    pub bytes: Option<f64>,
    /// Transfer rate in bytes per second.
    pub bytes_per_sec: Option<f64>,
}

/// Progress of a clone, which has no repository (and so no `op_id`) yet.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct CloneProgress {
    pub clone_id: String,
    /// Git phase as printed by Git, e.g. `Receiving objects` (not translated).
    pub phase: String,
    /// 0–100 when Git reports a percentage.
    pub percent: Option<u8>,
    pub current: Option<u32>,
    pub total: Option<u32>,
}

/// Progress of the download of an update (SPEC §10), at most once per percent.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    /// 0–100, `None` while the size is unknown.
    pub percent: Option<u8>,
}

/// Progress of a folder scan (F-007), at most every 100 ms.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub scan_id: String,
    /// Folders explored so far.
    pub visited: u32,
    /// Repositories found so far.
    pub found: u32,
    /// Folder being explored.
    pub current: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpOutcome {
    /// `note`: the operation succeeded but did not complete what it started (see `OpNote`).
    Success {
        note: Option<OpNote>,
    },
    Failed {
        error: YagguiError,
    },
    Cancelled,
}

/// How a success should read when Git reports success for something that did not complete.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum OpNote {
    /// A continue, skip or interactive rebase that halted on the next stop (`edit`).
    Paused,
    /// An abort of the operation in progress.
    Aborted,
}

/// An operation finished; the frontend should refresh what it touched.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct OpFinished {
    pub repo_id: u32,
    pub op_id: u32,
    pub kind: OpKind,
    pub outcome: OpOutcome,
}

/// The worktree, index or operation state changed (debounced): refetch `repo_state` / status.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct StatusChanged {
    pub repo_id: u32,
}

/// HEAD or refs changed (debounced): refetch branches, graph and `repo_state`.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct RefsChanged {
    pub repo_id: u32,
}

/// Progress of the history walk behind the graph (M5-4), sent when a page went out before the
/// walk was done: the number of rows grows until `exact`. Rows never move within a version.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct GraphProgress {
    pub repo_id: u32,
    pub version: u32,
    /// Rows so far; the final count once `exact`.
    pub total_rows: u32,
    pub exact: bool,
    /// This version is dropped (commit dates misled the walk): reload the graph.
    pub stale: bool,
}

/// The undo journal of a repository changed (operation journaled, undone or redone):
/// refetch `undo_state` / `op_history`.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct JournalChanged {
    pub repo_id: u32,
}

/// Output of an integrated terminal (F-267), batched: at most one event every few
/// milliseconds per terminal. `data` is UTF-8; a character split across two reads is sent
/// whole with the second.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutput {
    pub pty_id: u32,
    pub data: String,
}

/// The shell of an integrated terminal exited (or was closed); sent after its last output.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct PtyExited {
    pub pty_id: u32,
    /// `None` when the exit status is unknown (killed by a signal, or not reaped in time).
    pub exit_code: Option<u32>,
}

/// Every event the backend can emit, so services stay independent from Tauri.
#[derive(Debug, Clone)]
pub enum BackendEvent {
    CommandLogged(CommandLogged),
    OpStarted(OpStarted),
    OpProgress(OpProgress),
    CloneProgress(CloneProgress),
    ScanProgress(ScanProgress),
    OpFinished(OpFinished),
    StatusChanged(StatusChanged),
    RefsChanged(RefsChanged),
    GraphProgress(GraphProgress),
    JournalChanged(JournalChanged),
    PtyOutput(PtyOutput),
    PtyExited(PtyExited),
}

/// Destination of backend events: the Tauri app in production, a recorder in tests.
pub trait EventSink: Send + Sync {
    fn emit(&self, event: BackendEvent);
}

/// Sink that drops every event (CLI tools, tests that do not care).
#[derive(Debug, Default)]
pub struct NullSink;

impl EventSink for NullSink {
    fn emit(&self, _event: BackendEvent) {}
}

/// Forwards events to the webview.
pub struct TauriSink(pub tauri::AppHandle);

impl EventSink for TauriSink {
    fn emit(&self, event: BackendEvent) {
        let app = &self.0;
        let result = match event {
            BackendEvent::CommandLogged(e) => e.emit(app),
            BackendEvent::OpStarted(e) => e.emit(app),
            BackendEvent::OpProgress(e) => e.emit(app),
            BackendEvent::CloneProgress(e) => e.emit(app),
            BackendEvent::ScanProgress(e) => e.emit(app),
            BackendEvent::OpFinished(e) => e.emit(app),
            BackendEvent::StatusChanged(e) => e.emit(app),
            BackendEvent::RefsChanged(e) => e.emit(app),
            BackendEvent::GraphProgress(e) => e.emit(app),
            BackendEvent::JournalChanged(e) => e.emit(app),
            BackendEvent::PtyOutput(e) => e.emit(app),
            BackendEvent::PtyExited(e) => e.emit(app),
        };
        if let Err(err) = result {
            tracing::warn!(error = %err, "failed to emit event");
        }
    }
}
