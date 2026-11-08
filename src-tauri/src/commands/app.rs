use serde::Serialize;
use specta::Type;

use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::git::cli;
use crate::state::AppState;
use crate::system::changelog::{self, ChangelogRelease};
use crate::system::quit;

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// yaggui version, from `Cargo.toml`.
    pub app_version: String,
    /// Version of the detected `git` binary (e.g. `2.43.0`), `None` if git was not found.
    pub git_version: Option<String>,
    /// `false` when the detected git is older than `min_git_version` (warning shown in the UI).
    pub git_supported: bool,
    pub min_git_version: String,
}

/// Returns the app version and the version of the system `git` binary.
#[tauri::command]
#[specta::specta]
pub async fn app_info(app: AppHandle) -> AppInfo {
    // An owned handle (not `State<'_>`) keeps this command infallible for the frontend.
    let git = Arc::clone(&app.state::<AppState>().git);
    // Spawning git blocks: keep it off the async runtime threads.
    let git_version = tauri::async_runtime::spawn_blocking(move || git.version())
        .await
        .unwrap_or_else(|err| {
            tracing::warn!(error = %err, "git version detection task failed");
            None
        });

    AppInfo {
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        git_supported: git_version
            .as_deref()
            .is_some_and(cli::is_supported_version),
        git_version,
        min_git_version: cli::MIN_GIT_VERSION.to_owned(),
    }
}

/// Release notes embedded from `CHANGELOG.md`, newest first.
#[tauri::command]
#[specta::specta]
pub async fn changelog() -> Vec<ChangelogRelease> {
    changelog::releases()
}

static LAUNCH_PATH: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

/// Reads the path of the command line while the process is still in its start folder: a
/// relative one (`yaggui .`) is resolved against it, before `lib.rs` leaves that folder.
pub fn capture_launch_path() {
    LAUNCH_PATH.get_or_init(read_launch_path);
}

fn read_launch_path() -> Option<String> {
    let arg = std::env::args_os()
        .skip(1)
        .find(|arg| !arg.to_string_lossy().starts_with('-'))?;
    let path = std::path::absolute(&arg).unwrap_or_else(|_| arg.into());
    Some(path.to_string_lossy().into_owned())
}

/// Path given on the command line (`yaggui <path>`), if any, to open at startup (F-001).
#[tauri::command]
#[specta::specta]
pub async fn launch_path() -> Option<String> {
    LAUNCH_PATH.get_or_init(read_launch_path).clone()
}

// Quit and close guard (see `system::quit`).

/// Quits the app. The frontend calls it once the quit is confirmed and the session saved.
#[tauri::command]
#[specta::specta]
pub fn quit_app(app: AppHandle) {
    tracing::info!("quitting at the user's request");
    app.exit(0);
}

/// The frontend received a quit or close request: the next one waits for it again.
#[tauri::command]
#[specta::specta]
pub fn acknowledge_quit_request() {
    quit::GATE.acknowledge();
}

/// Whether something a quit would interrupt or lose is in progress (a running operation,
/// unsaved edits): a native quit (⌘Q, the macOS Dock) then asks the frontend first.
#[tauri::command]
#[specta::specta]
pub fn set_quit_guard(active: bool) {
    quit::GATE.set_guarded(active);
}
