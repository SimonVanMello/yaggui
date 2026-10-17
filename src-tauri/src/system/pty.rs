//! Integrated terminal (F-267): the user's shell in a pseudo-terminal, started in the
//! repository folder.
//!
//! Not a Git command, so nothing here goes through `git/cli.rs`, and the environment is
//! inherited as is (no `GIT_TERMINAL_PROMPT=0`, no `LC_ALL`): it is the user's shell. Only
//! `TERM` / `COLORTERM` are set, to describe the emulator.
//!
//! Each terminal has three threads: a reader that drains the PTY, an emitter that batches
//! that output into `pty-output` events (at most one every [`FLUSH_INTERVAL`]), and a waiter
//! that reaps the shell and sends `pty-exited` after the last output.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::events::{BackendEvent, EventSink, PtyExited, PtyOutput};
use crate::git::errors::YagguiError;

/// Output read during this delay is sent in one event: a burst (`cat` of a big file) costs
/// a few events per frame instead of one per read.
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(8);
/// Largest `data` of one event.
const MAX_EVENT_BYTES: usize = 64 * 1024;
/// Output kept while the emitter is behind; the reader (and so the shell) waits beyond it.
const MAX_PENDING_BYTES: usize = 1024 * 1024;
/// How long the end of the output may lag behind the exit of the shell (or the reverse).
const EXIT_GRACE: Duration = Duration::from_secs(2);
const READ_BUFFER: usize = 16 * 1024;
/// Accepted terminal sizes, in cells.
pub const PTY_SIZE_RANGE: std::ops::RangeInclusive<u16> = 1..=1000;

/// A started terminal.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    pub pty_id: u32,
    /// The shell that was started (`/bin/zsh`, `pwsh.exe`…), for the tab title.
    pub shell: String,
}

/// Shell of the integrated terminal on Windows: PowerShell 7 if installed, else Windows
/// PowerShell, else `cmd`. `path` is `%PATH%` (`;`-separated, whatever the host).
pub fn windows_shell(
    path: Option<&OsStr>,
    exists: impl Fn(&Path) -> bool,
) -> (PathBuf, Vec<&'static str>) {
    let dirs: Vec<PathBuf> = path
        .map(|p| {
            p.to_string_lossy()
                .split(';')
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default();
    for name in ["pwsh.exe", "powershell.exe"] {
        if let Some(found) = dirs.iter().map(|d| d.join(name)).find(|p| exists(p)) {
            return (found, vec!["-NoLogo"]);
        }
    }
    (PathBuf::from("cmd.exe"), Vec::new())
}

/// The shell to start, and its name for the UI.
fn shell_command() -> (CommandBuilder, String) {
    #[cfg(windows)]
    {
        let (program, args) = windows_shell(std::env::var_os("PATH").as_deref(), Path::is_file);
        let mut command = CommandBuilder::new(&program);
        command.args(args);
        let name = program
            .file_name()
            .map_or_else(|| program.to_string_lossy(), |n| n.to_string_lossy())
            .into_owned();
        (command, name)
    }
    #[cfg(not(windows))]
    {
        // `$SHELL` (or the password database) as a login shell (`-zsh` as argv[0]), like
        // Terminal.app and most emulators.
        let command = CommandBuilder::new_default_prog();
        let name = command.get_shell();
        (command, name)
    }
}

/// Appends `bytes` to the bytes left over from the previous call and returns the decoded
/// text. A sequence cut at the end is kept for the next call; invalid bytes become U+FFFD.
pub fn decode_utf8(carry: &mut Vec<u8>, bytes: &[u8]) -> String {
    carry.extend_from_slice(bytes);
    let mut out = String::with_capacity(carry.len());
    let mut start = 0;
    while start < carry.len() {
        match std::str::from_utf8(&carry[start..]) {
            Ok(text) => {
                out.push_str(text);
                start = carry.len();
            }
            Err(err) => {
                let valid = start + err.valid_up_to();
                out.push_str(&String::from_utf8_lossy(&carry[start..valid]));
                match err.error_len() {
                    Some(len) => {
                        out.push(char::REPLACEMENT_CHARACTER);
                        start = valid + len;
                    }
                    None => {
                        start = valid;
                        break;
                    }
                }
            }
        }
    }
    carry.drain(..start);
    out
}

/// Output of one terminal between the reader, the waiter and the emitter.
#[derive(Default)]
struct Stream {
    state: Mutex<StreamState>,
    changed: Condvar,
}

#[derive(Default)]
struct StreamState {
    pending: Vec<u8>,
    /// No more output will come.
    eof: bool,
    /// Set once the shell is reaped: `Some(None)` when its exit code is unknown.
    exit: Option<Option<u32>>,
}

impl Stream {
    fn lock(&self) -> MutexGuard<'_, StreamState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn wait<'a>(
        &self,
        guard: MutexGuard<'a, StreamState>,
        condition: impl FnMut(&mut StreamState) -> bool,
    ) -> MutexGuard<'a, StreamState> {
        self.changed
            .wait_while(guard, condition)
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn wait_timeout<'a>(
        &self,
        guard: MutexGuard<'a, StreamState>,
        timeout: Duration,
        condition: impl FnMut(&mut StreamState) -> bool,
    ) -> MutexGuard<'a, StreamState> {
        match self.changed.wait_timeout_while(guard, timeout, condition) {
            Ok((guard, _)) => guard,
            Err(poisoned) => poisoned.into_inner().0,
        }
    }
}

/// Input side of a running terminal.
struct Io {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

/// A running terminal. The killer is apart from the input: a write blocked on a shell that
/// does not read must not keep the terminal from being closed.
struct Session {
    /// `None` for a terminal that belongs to no repository (an update).
    repo_id: Option<u32>,
    io: Mutex<Io>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

impl Session {
    /// Ends the shell: SIGHUP on Unix, `TerminateProcess` on Windows. Dropping the session
    /// then closes the PTY (pseudo console), which ends what the shell left running.
    fn kill(&self) {
        let mut killer = self
            .killer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Fails only when the shell is already gone.
        let _ = killer.kill();
    }

    fn io(&self) -> MutexGuard<'_, Io> {
        self.io
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

type Sessions = Arc<Mutex<HashMap<u32, Arc<Session>>>>;

fn lock_sessions(sessions: &Sessions) -> MutexGuard<'_, HashMap<u32, Arc<Session>>> {
    sessions
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Ends terminals removed from the map, outside its lock: closing a pseudo console can take
/// a moment on Windows.
fn end(removed: impl IntoIterator<Item = Arc<Session>>) {
    for session in removed {
        session.kill();
    }
}

/// The integrated terminals of every repository.
pub struct PtyManager {
    sink: Arc<dyn EventSink>,
    sessions: Sessions,
    next_id: AtomicU32,
}

impl PtyManager {
    pub fn new(sink: Arc<dyn EventSink>) -> Self {
        Self {
            sink,
            sessions: Arc::default(),
            next_id: AtomicU32::new(1),
        }
    }

    /// Starts the user's shell in `cwd`, for the repository `repo_id`.
    pub fn spawn(
        &self,
        repo_id: u32,
        cwd: &Path,
        cols: u16,
        rows: u16,
    ) -> Result<PtyInfo, YagguiError> {
        let (command, shell) = shell_command();
        self.spawn_command(Some(repo_id), command, shell, cwd, cols, rows)
    }

    /// Starts `program` with `args` in `cwd`, outside any repository. `program` is started
    /// directly, never through a shell.
    pub fn spawn_program(
        &self,
        program: &Path,
        args: &[String],
        cwd: &Path,
        cols: u16,
        rows: u16,
    ) -> Result<PtyInfo, YagguiError> {
        let mut command = CommandBuilder::new(program);
        command.args(args);
        let name = program.to_string_lossy().into_owned();
        self.spawn_command(None, command, name, cwd, cols, rows)
    }

    fn spawn_command(
        &self,
        repo_id: Option<u32>,
        mut command: CommandBuilder,
        shell: String,
        cwd: &Path,
        cols: u16,
        rows: u16,
    ) -> Result<PtyInfo, YagguiError> {
        let size = pty_size(cols, rows)?;
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let failed =
            |err: &dyn std::fmt::Display| YagguiError::shell_failed(&shell, err.to_string());
        let pair = native_pty_system()
            .openpty(size)
            .map_err(|err| failed(&err))?;
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|err| failed(&err))?;
        // Only the shell holds the terminal side: its exit then ends the output (Unix).
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|err| failed(&err))?;
        let writer = pair.master.take_writer().map_err(|err| failed(&err))?;
        let session = Arc::new(Session {
            repo_id,
            io: Mutex::new(Io {
                master: pair.master,
                writer,
            }),
            killer: Mutex::new(child.clone_killer()),
        });
        let pty_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let stream = Arc::new(Stream::default());

        // Until the session is stored, an early return must end the shell; the threads
        // already started then see the end of the output and stop.
        let started = spawn_thread("yaggui-pty-emit", {
            let stream = Arc::clone(&stream);
            let sink = Arc::clone(&self.sink);
            move || emit_output(pty_id, &stream, &*sink)
        })
        .and_then(|()| {
            spawn_thread("yaggui-pty-read", {
                let stream = Arc::clone(&stream);
                move || read_output(reader, &stream)
            })
        });
        if let Err(err) = started {
            session.kill();
            return Err(err);
        }
        lock_sessions(&self.sessions).insert(pty_id, session);
        let waiter = spawn_thread("yaggui-pty-wait", {
            let sessions = Arc::clone(&self.sessions);
            move || {
                let exit = match child.wait() {
                    Ok(status) if status.signal().is_none() => Some(status.exit_code()),
                    Ok(_) => None,
                    Err(err) => {
                        tracing::warn!(pty_id, error = %err, "cannot wait for the shell");
                        None
                    }
                };
                // Closes the pseudo console: on Windows, the output only ends then.
                let removed = lock_sessions(&sessions).remove(&pty_id);
                end(removed);
                let mut state = stream.lock();
                state.exit = Some(exit);
                stream.changed.notify_all();
                // A background job may keep the terminal open (Unix): stop waiting for it.
                let mut state = stream.wait_timeout(state, EXIT_GRACE, |s| !s.eof);
                state.eof = true;
                stream.changed.notify_all();
            }
        });
        if let Err(err) = waiter {
            self.close(pty_id);
            return Err(err);
        }
        tracing::info!(pty_id, ?repo_id, shell = %shell, cwd = %cwd.display(), "terminal started");
        Ok(PtyInfo { pty_id, shell })
    }

    fn get(&self, pty_id: u32) -> Result<Arc<Session>, YagguiError> {
        lock_sessions(&self.sessions)
            .get(&pty_id)
            .cloned()
            .ok_or_else(|| YagguiError::terminal_closed(pty_id))
    }

    /// Sends keyboard input (or pasted text) to the shell. May block while the shell does
    /// not read its input.
    pub fn write(&self, pty_id: u32, data: &str) -> Result<(), YagguiError> {
        let session = self.get(pty_id)?;
        let mut io = session.io();
        io.writer
            .write_all(data.as_bytes())
            .and_then(|()| io.writer.flush())
            .map_err(|err| match err.kind() {
                ErrorKind::BrokenPipe => YagguiError::terminal_closed(pty_id),
                _ => YagguiError::internal(format!("pty {pty_id}: {err}")),
            })
    }

    pub fn resize(&self, pty_id: u32, cols: u16, rows: u16) -> Result<(), YagguiError> {
        let size = pty_size(cols, rows)?;
        let session = self.get(pty_id)?;
        session
            .io()
            .master
            .resize(size)
            .map_err(|err| YagguiError::internal(format!("pty {pty_id}: {err}")))
    }

    /// Ends a terminal. No-op if it already exited.
    pub fn close(&self, pty_id: u32) {
        let removed = lock_sessions(&self.sessions).remove(&pty_id);
        end(removed);
    }

    /// Ends every terminal of a repository (its last tab was closed).
    pub fn close_repo(&self, repo_id: u32) {
        let removed: Vec<_> = {
            let mut sessions = lock_sessions(&self.sessions);
            let ids: Vec<u32> = sessions
                .iter()
                .filter(|(_, s)| s.repo_id == Some(repo_id))
                .map(|(id, _)| *id)
                .collect();
            ids.iter().filter_map(|id| sessions.remove(id)).collect()
        };
        if !removed.is_empty() {
            tracing::info!(
                repo_id,
                count = removed.len(),
                "terminals closed with the repository"
            );
        }
        end(removed);
    }

    /// Ends every terminal (the app quits).
    pub fn close_all(&self) {
        let removed: Vec<_> = lock_sessions(&self.sessions)
            .drain()
            .map(|(_, s)| s)
            .collect();
        end(removed);
    }

    /// Number of running terminals of `repo_id`.
    pub fn count(&self, repo_id: u32) -> usize {
        lock_sessions(&self.sessions)
            .values()
            .filter(|s| s.repo_id == Some(repo_id))
            .count()
    }
}

impl Drop for PtyManager {
    fn drop(&mut self) {
        self.close_all();
    }
}

fn spawn_thread(name: &str, work: impl FnOnce() + Send + 'static) -> Result<(), YagguiError> {
    std::thread::Builder::new()
        .name(name.to_owned())
        .spawn(work)
        .map(drop)
        .map_err(|err| YagguiError::internal(format!("{name}: {err}")))
}

/// Drains the PTY into the stream until the end of the output.
fn read_output(mut reader: Box<dyn Read + Send>, stream: &Stream) {
    let mut buffer = vec![0_u8; READ_BUFFER];
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(err) if err.kind() == ErrorKind::Interrupted => continue,
            // EIO: the shell side closed (Unix).
            Err(_) => break,
        };
        let state = stream.lock();
        let mut state = stream.wait(state, |s| s.pending.len() >= MAX_PENDING_BYTES && !s.eof);
        if state.eof {
            return;
        }
        state.pending.extend_from_slice(&buffer[..read]);
        stream.changed.notify_all();
    }
    stream.lock().eof = true;
    stream.changed.notify_all();
}

/// Sends the output as batched events, then `pty-exited`.
fn emit_output(pty_id: u32, stream: &Stream, sink: &dyn EventSink) {
    let mut carry = Vec::new();
    loop {
        {
            let state = stream.lock();
            let state = stream.wait(state, |s| s.pending.is_empty() && !s.eof);
            if state.pending.is_empty() {
                break;
            }
        }
        std::thread::sleep(FLUSH_INTERVAL);
        let bytes = std::mem::take(&mut stream.lock().pending);
        stream.changed.notify_all();
        for chunk in bytes.chunks(MAX_EVENT_BYTES) {
            let data = decode_utf8(&mut carry, chunk);
            if !data.is_empty() {
                sink.emit(BackendEvent::PtyOutput(PtyOutput { pty_id, data }));
            }
        }
    }
    if !carry.is_empty() {
        let data = String::from_utf8_lossy(&carry).into_owned();
        sink.emit(BackendEvent::PtyOutput(PtyOutput { pty_id, data }));
    }
    let state = stream.lock();
    let state = stream.wait_timeout(state, EXIT_GRACE, |s| s.exit.is_none());
    let exit_code = state.exit.flatten();
    drop(state);
    tracing::info!(pty_id, ?exit_code, "terminal exited");
    sink.emit(BackendEvent::PtyExited(PtyExited { pty_id, exit_code }));
}

fn pty_size(cols: u16, rows: u16) -> Result<PtySize, YagguiError> {
    if !PTY_SIZE_RANGE.contains(&cols) || !PTY_SIZE_RANGE.contains(&rows) {
        return Err(YagguiError::invalid_argument(
            format!("Invalid terminal size {cols}×{rows}."),
            format!("Taille de terminal invalide : {cols}×{rows}."),
        ));
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoding_keeps_a_character_split_across_reads() {
        let mut carry = Vec::new();
        let bytes = "é→ok".as_bytes();
        assert_eq!(decode_utf8(&mut carry, &bytes[..1]), "");
        assert_eq!(carry, [0xC3]);
        assert_eq!(decode_utf8(&mut carry, &bytes[1..3]), "é");
        assert_eq!(decode_utf8(&mut carry, &bytes[3..]), "→ok");
        assert!(carry.is_empty());
    }

    #[test]
    fn decoding_replaces_invalid_bytes() {
        let mut carry = Vec::new();
        assert_eq!(decode_utf8(&mut carry, b"a\xFFb\xC3"), "a\u{FFFD}b");
        assert_eq!(carry, [0xC3]);
        // A byte that cannot continue the kept sequence: both are replaced, nothing kept.
        assert_eq!(decode_utf8(&mut carry, b"z"), "\u{FFFD}z");
        assert!(carry.is_empty());
    }

    #[test]
    fn windows_prefers_pwsh_then_powershell_then_cmd() {
        let ps5 = r"C:\Windows\System32\WindowsPowerShell\v1.0";
        let ps7 = r"C:\Program Files\PowerShell\7";
        let path = format!(r"{ps5};{ps7}; C:\Windows\System32;");
        let installed = |files: Vec<PathBuf>| move |p: &Path| files.iter().any(|f| f == p);
        let pwsh = Path::new(ps7).join("pwsh.exe");
        let powershell = Path::new(ps5).join("powershell.exe");

        let found = windows_shell(
            Some(OsStr::new(&path)),
            installed(vec![powershell.clone(), pwsh.clone()]),
        );
        assert_eq!(found, (pwsh, vec!["-NoLogo"]));

        let found = windows_shell(Some(OsStr::new(&path)), installed(vec![powershell.clone()]));
        assert_eq!(found, (powershell, vec!["-NoLogo"]));

        let found = windows_shell(Some(OsStr::new(&path)), installed(Vec::new()));
        assert_eq!(found, (PathBuf::from("cmd.exe"), Vec::new()));
        assert_eq!(windows_shell(None, |_| true).0, PathBuf::from("cmd.exe"));
    }

    #[test]
    fn sizes_are_bounded() {
        assert!(pty_size(80, 24).is_ok());
        assert!(pty_size(0, 24).is_err());
        assert!(pty_size(80, 1001).is_err());
    }

    #[test]
    fn unknown_terminals_are_a_typed_error() {
        let manager = PtyManager::new(Arc::new(crate::events::NullSink));
        let err = manager.write(42, "ls\r").expect_err("no such terminal");
        assert_eq!(err.code, crate::git::errors::ErrorCode::TerminalClosed);
        assert!(manager.resize(42, 80, 24).is_err());
        // Closing twice, or something that never existed, is not an error.
        manager.close(42);
    }
}
