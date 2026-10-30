use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;

use tauri::State;

use super::blocking;
use crate::git::errors::YagguiError;
use crate::state::AppState;
use crate::system::diagnostics::{self, CrashSummary, Environment};
use crate::system::{editor, git_binary, updates};

/// The bug form of the issue tracker; the user pastes the copied report into it.
pub const NEW_ISSUE_URL: &str =
    "https://github.com/SimonVanMello/yaggui/issues/new?template=bug_report.yml";

fn log_dir() -> Result<PathBuf, YagguiError> {
    diagnostics::current_log_dir()
        .map(PathBuf::from)
        .ok_or_else(|| YagguiError::internal("the log folder is not known yet"))
}

/// Crash reports of earlier sessions the user has not been told about, oldest first.
#[tauri::command]
#[specta::specta]
pub async fn pending_crash_reports() -> Result<Vec<CrashSummary>, YagguiError> {
    let dir = log_dir()?;
    blocking(move || Ok(diagnostics::pending_crashes(&dir))).await
}

/// The user was told about the pending crash reports: they are not listed again.
#[tauri::command]
#[specta::specta]
pub async fn acknowledge_crash_reports() -> Result<(), YagguiError> {
    let dir = log_dir()?;
    blocking(move || {
        diagnostics::acknowledge_crashes(&dir).map_err(|err| {
            YagguiError::internal(format!("cannot save the crash reports seen: {err}"))
        })
    })
    .await
}

/// Opens the folder of the session logs and crash reports in the file manager:
/// `fileManagerFailed`.
#[tauri::command]
#[specta::specta]
pub async fn open_logs_folder() -> Result<(), YagguiError> {
    let dir = log_dir()?;
    blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|err| {
            YagguiError::logs_folder_failed().with_detail(format!("{}: {err}", dir.display()))
        })?;
        editor::open_folder(&dir).map_err(|err| {
            let failed = YagguiError::logs_folder_failed();
            match err.detail {
                Some(detail) => failed.with_detail(detail),
                None => failed,
            }
        })
    })
    .await
}

/// Markdown for a bug report: versions (yaggui, OS, WebView, Git), the latest crash report
/// of the week and the end of the session logs. Read by the user before they paste it.
#[tauri::command]
#[specta::specta]
pub async fn bug_report(state: State<'_, AppState>) -> Result<String, YagguiError> {
    let dir = log_dir()?;
    let git = Arc::clone(&state.git);
    blocking(move || {
        let binary = git.binary();
        let git_path = if binary.is_absolute() {
            Some(binary)
        } else {
            git_binary::detect()
        };
        let environment = Environment {
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            install: format!("{:?}", updates::install_channel()),
            os: diagnostics::os_description(),
            webview: tauri::webview_version().ok(),
            git_version: git.version(),
            git_path: git_path.map(|path| path.display().to_string()),
        };
        Ok(diagnostics::bug_report(
            &dir,
            &environment,
            SystemTime::now(),
        ))
    })
    .await
}

/// Opens the bug form of the issue tracker in the browser: `browserFailed`.
#[tauri::command]
#[specta::specta]
pub async fn open_issue_tracker() -> Result<(), YagguiError> {
    blocking(|| editor::open_url(NEW_ISSUE_URL)).await
}

/// Writes an uncaught frontend error to the session log. `kind`: `render`, `error` or
/// `rejection`.
#[tauri::command]
#[specta::specta]
pub async fn log_frontend_error(kind: String, message: String, stack: Option<String>) {
    diagnostics::log_frontend_error(&kind, &message, stack.as_deref());
}
