//! In-memory, bounded journal of every executed Git command (F-300).

use std::collections::VecDeque;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;

/// Maximum number of entries kept; older ones are dropped first.
pub const MAX_LOG_ENTRIES: usize = 500;
/// Maximum bytes kept per output stream, so one noisy command cannot bloat the log.
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CommandStatus {
    Success,
    Failed,
    Cancelled,
    /// The process could not be started (git missing, bad cwd…).
    SpawnFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommandLogEntry {
    /// Monotonic id, unique for the app run.
    pub id: u32,
    /// Repository the command ran for, if any.
    pub repo_id: Option<u32>,
    /// Program run when it is not `git` (`claude`), or the AI provider called
    /// (`claude-api`); `None` for Git commands.
    #[serde(default)]
    pub program: Option<String>,
    /// Arguments after the program (e.g. `["fetch", "--progress", "origin"]`).
    pub args: Vec<String>,
    pub cwd: Option<String>,
    /// Start time, seconds since the Unix epoch.
    pub started_at: u32,
    pub duration_ms: u32,
    /// Process exit code; `None` if killed or never started.
    pub exit_code: Option<i32>,
    pub status: CommandStatus,
    pub stdout: String,
    pub stderr: String,
    /// `true` when stdout or stderr was cut to `MAX_OUTPUT_BYTES`.
    pub truncated: bool,
}

/// Thread-safe ring buffer of command entries.
#[derive(Debug, Default)]
pub struct CommandLog {
    inner: Mutex<LogInner>,
}

#[derive(Debug, Default)]
struct LogInner {
    next_id: u32,
    entries: VecDeque<CommandLogEntry>,
}

impl CommandLog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Stores the entry after assigning its id, and returns the stored copy.
    pub fn push(&self, mut entry: CommandLogEntry) -> CommandLogEntry {
        let mut inner = lock(&self.inner);
        inner.next_id = inner.next_id.wrapping_add(1);
        entry.id = inner.next_id;
        if inner.entries.len() == MAX_LOG_ENTRIES {
            inner.entries.pop_front();
        }
        inner.entries.push_back(entry.clone());
        entry
    }

    /// All entries, oldest first.
    pub fn entries(&self) -> Vec<CommandLogEntry> {
        lock(&self.inner).entries.iter().cloned().collect()
    }

    pub fn clear(&self) {
        lock(&self.inner).entries.clear();
    }
}

/// A poisoned lock only means another thread panicked mid-push; the ring buffer stays valid.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Lossy UTF-8 decode, cut to `MAX_OUTPUT_BYTES` on a char boundary. Returns `(text, truncated)`.
pub fn bounded_output(bytes: &[u8]) -> (String, bool) {
    let text = String::from_utf8_lossy(bytes);
    if text.len() <= MAX_OUTPUT_BYTES {
        return (text.into_owned(), false);
    }
    let mut end = MAX_OUTPUT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> CommandLogEntry {
        CommandLogEntry {
            id: 0,
            repo_id: None,
            program: None,
            args: vec!["status".into()],
            cwd: None,
            started_at: 0,
            duration_ms: 1,
            exit_code: Some(0),
            status: CommandStatus::Success,
            stdout: String::new(),
            stderr: String::new(),
            truncated: false,
        }
    }

    #[test]
    fn assigns_ids_and_bounds_size() {
        let log = CommandLog::new();
        for _ in 0..MAX_LOG_ENTRIES + 5 {
            log.push(entry());
        }
        let entries = log.entries();
        assert_eq!(entries.len(), MAX_LOG_ENTRIES);
        assert_eq!(entries[0].id, 6);
        assert_eq!(
            entries.last().map(|e| e.id),
            Some((MAX_LOG_ENTRIES + 5) as u32)
        );
        log.clear();
        assert!(log.entries().is_empty());
    }

    #[test]
    fn truncates_long_output_on_char_boundary() {
        let bytes = "é".repeat(MAX_OUTPUT_BYTES).into_bytes();
        let (text, truncated) = bounded_output(&bytes);
        assert!(truncated);
        assert!(text.len() <= MAX_OUTPUT_BYTES);
        assert!(text.chars().all(|c| c == 'é'));
    }
}
