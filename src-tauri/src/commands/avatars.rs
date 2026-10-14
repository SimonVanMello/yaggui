use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::git::errors::YagguiError;
use crate::state::AppState;
use crate::system::avatars::data_url;

/// Gravatar image of a SHA-256 e-mail hash as a `data:` URL, `None` when the address has no
/// Gravatar (F-033). The `gravatar` preference is the frontend's to honor: it only asks when
/// the option is on (a backend check would race with the save of the preference itself).
#[tauri::command]
#[specta::specta]
pub async fn avatar(
    state: State<'_, AppState>,
    hash: String,
) -> Result<Option<String>, YagguiError> {
    let avatars = Arc::clone(&state.avatars);
    blocking(move || Ok(avatars.get(&hash)?.and_then(|bytes| data_url(&bytes)))).await
}

/// Empties the avatar cache (preferences). Returns the number of files removed.
#[tauri::command]
#[specta::specta]
pub async fn clear_avatar_cache(state: State<'_, AppState>) -> Result<u32, YagguiError> {
    let avatars = Arc::clone(&state.avatars);
    blocking(move || Ok(u32::try_from(avatars.clear()?).unwrap_or(u32::MAX))).await
}
