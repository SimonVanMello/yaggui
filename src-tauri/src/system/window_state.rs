//! Size, position and maximized state of the main window, kept across restarts by the
//! official `tauri-plugin-window-state` in `window-state.json`, next to `yaggui.db`.

use std::path::{Path, PathBuf};

use tauri_plugin_window_state::StateFlags;

use crate::state::CONFIG_DIR_ENV;

pub const WINDOW_STATE_FILE: &str = "window-state.json";

/// What is restored. Never the visibility: the window starts hidden and the frontend shows it
/// once rendered (the plugin would show it at once). Nor the decorations, set by the app per
/// platform, nor full screen.
pub fn flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

/// The plugin joins this name to the OS config folder: an absolute path (`YAGGUI_CONFIG_DIR`,
/// used by the tests and benchmarks) replaces it, so the file follows the database.
fn file_name() -> String {
    match std::env::var_os(CONFIG_DIR_ENV) {
        Some(dir) => PathBuf::from(dir)
            .join(WINDOW_STATE_FILE)
            .to_string_lossy()
            .into_owned(),
        None => WINDOW_STATE_FILE.to_owned(),
    }
}

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_window_state::Builder::new()
        .with_state_flags(flags())
        .with_filename(file_name())
        .build()
}

/// Debug log of the state the plugin restores (it logs nothing itself).
pub fn log_restored(config_dir: &Path) {
    let path = config_dir.join(WINDOW_STATE_FILE);
    match std::fs::read(&path) {
        Ok(bytes) => {
            let main = serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .and_then(|states| states.get("main").cloned());
            tracing::debug!(path = %path.display(), state = ?main, "window state restored");
        }
        Err(err) => {
            tracing::debug!(path = %path.display(), error = %err, "no saved window state");
        }
    }
}
