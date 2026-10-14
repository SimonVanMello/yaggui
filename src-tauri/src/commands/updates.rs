use tauri::AppHandle;
use tauri_specta::Event;

use super::blocking;
use crate::events::UpdateProgress;
use crate::git::errors::YagguiError;
use crate::system::updates::{self, UpdateInfo};

/// Newer published version, `None` when this one is the newest. The `check_updates`
/// preference is the frontend's to honor, like `gravatar`: a check asked from the palette
/// runs whatever it says.
#[tauri::command]
#[specta::specta]
pub async fn check_for_update() -> Result<Option<UpdateInfo>, YagguiError> {
    blocking(updates::check).await
}

/// Downloads and installs the newest version, then restarts the app (only returns on
/// failure). Progress comes as `update-progress` events.
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
