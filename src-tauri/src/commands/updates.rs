use std::sync::Arc;

use tauri::{AppHandle, State};
use tauri_specta::Event;

use super::blocking;
use crate::events::UpdateProgress;
use crate::git::errors::YagguiError;
use crate::state::AppState;
use crate::system::pty::PtyInfo;
use crate::system::updates::{self, UpdateInfo};

/// Newer published version, `None` when this one is the newest. The `check_updates`
/// preference is the frontend's to honor, like `gravatar`: a check asked from the palette
/// runs whatever it says.
#[tauri::command]
#[specta::specta]
pub async fn check_for_update() -> Result<Option<UpdateInfo>, YagguiError> {
    blocking(updates::check).await
}

/// Downloads and installs the newest version, then restarts the app (returns on failure, and
/// on macOS while the app exits). Progress comes as `update-progress` events.
#[tauri::command]
#[specta::specta]
pub async fn install_update(app: AppHandle) -> Result<(), YagguiError> {
    let emitter = app.clone();
    updates::install(&app, move |percent| {
        if let Err(err) = (UpdateProgress { percent }).emit(&emitter) {
            tracing::warn!(error = %err, "failed to emit update progress");
        }
    })
    .await
}

/// Opens the page of the newest release, for the installs that are upgraded by hand.
#[tauri::command]
#[specta::specta]
pub async fn open_release_page() -> Result<(), YagguiError> {
    blocking(updates::open_release_page).await
}

/// Upgrades a copy owned by a Linux package manager (AUR, `.deb`, `.rpm`): downloads the new
/// package if there is one (progress as `update-progress` events), then starts the package
/// manager in a terminal of `cols`×`rows` cells, where the user answers its prompts and types
/// their password. The command is chosen here, never by the frontend.
#[tauri::command]
#[specta::specta]
pub async fn update_in_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
) -> Result<PtyInfo, YagguiError> {
    let cache_dir = state.cache_dir.clone();
    let ptys = Arc::clone(&state.ptys);
    blocking(move || {
        let command = updates::prepare_upgrade(&cache_dir, |percent| {
            if let Err(err) = (UpdateProgress { percent }).emit(&app) {
                tracing::warn!(error = %err, "failed to emit update progress");
            }
        })?;
        ptys.spawn_program(&command.program, &command.args, &cache_dir, cols, rows)
    })
    .await
}

/// Restarts the app, on the version a package manager just installed.
#[tauri::command]
#[specta::specta]
pub fn restart_app(app: AppHandle) {
    tracing::info!("restarting after an upgrade");
    updates::restart(&app);
}
