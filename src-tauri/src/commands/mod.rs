//! Tauri command handlers. Keep them thin: validate, call a service, map errors.

pub mod app;
pub mod avatars;
pub mod commit_tools;
pub mod create;
pub mod diff;
pub mod graph;
pub mod graph_tools;
pub mod history;
pub mod inspect;
pub mod log;
pub mod modules;
pub mod network;
pub mod pty;
pub mod refs;
pub mod remotes;
pub mod repo;
pub mod settings;
pub mod store;
pub mod system;
pub mod undo;
pub mod updates;
pub mod workspaces;
pub mod write;

use crate::git::errors::{BackendError, YagguiError};

/// Runs blocking work (git, gix, SQLite) off the async runtime threads.
pub(crate) async fn blocking<T, F>(work: F) -> Result<T, YagguiError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, YagguiError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|err| YagguiError::from(BackendError::task("background task failed", err)))?
}
