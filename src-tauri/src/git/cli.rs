//! The only place allowed to spawn the `git` binary.
//!
//! Every invocation gets a controlled environment (no prompt, no editor, stable output),
//! is recorded in the command log (and announced with `command-logged`), can be cancelled,
//! and can report `--progress` output.

use std::ffi::{OsStr, OsString};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, PoisonError, RwLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::events::{BackendEvent, CommandLogged, EventSink};
use crate::git::errors::{BackendError, YagguiError, classify_git_failure};
use crate::git::log::{CommandLog, CommandLogEntry, CommandStatus, bounded_output};
use crate::git::redact::redact_urls;

/// Oldest Git version yaggui is tested against; older ones get a warning.
pub const MIN_GIT_VERSION: &str = "2.30";

/// Binary used until a path is configured: looked up on the `PATH` by the OS.
pub const DEFAULT_GIT: &str = "git";

/// How often a cancellable command checks its cancel flag.
const POLL_INTERVAL: Duration = Duration::from_millis(20);
/// How long the output of an exited command is awaited while processes it left hold it open.
const PIPES_GRACE: Duration = Duration::from_secs(2);
/// After a kill, how long to wait for the output pipes to close. Helpers spawned by git
/// (ssh, credential helpers) may keep them open after git itself died.
const CANCEL_GRACE: Duration = Duration::from_millis(500);
/// After asking a cancelled command to stop, how long before it is killed. Git removes its
/// lock files when terminated, not when killed.
#[cfg(unix)]
const TERMINATE_GRACE: Duration = Duration::from_secs(1);

/// Variables that relocate the repository or inject configuration. Inherited from a parent
/// process (yaggui launched from a Git hook, a terminal inside `git rebase -x`…), they
/// would make git act on another repository than the one we pass with `cwd`.
const INHERITED_GIT_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_QUARANTINE_PATH",
    "GIT_REFLOG_ACTION",
    "GIT_INTERNAL_SUPER_PREFIX",
];

/// `true` when `version` (as returned by `git_version`) is at least `MIN_GIT_VERSION`.
pub fn is_supported_version(version: &str) -> bool {
    let mut parts = version.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    let major = parts.next().unwrap_or(0);
    let minor = parts.next().unwrap_or(0);
    (major, minor) >= (2, 30)
}

/// Shared cancellation flag for a running or queued command.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// One progress update parsed from Git's stderr.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitProgress {
    pub phase: String,
    pub percent: Option<u8>,
    pub current: Option<u32>,
    pub total: Option<u32>,
    /// Bytes transferred so far (`1.20 MiB`), for network phases.
    pub bytes: Option<u64>,
    /// Transfer rate in bytes per second (`| 1.00 MiB/s`).
    pub bytes_per_sec: Option<u64>,
}

/// A Git invocation to run through [`GitCli`].
#[derive(Debug, Clone)]
pub struct GitCommand {
    args: Vec<OsString>,
    cwd: Option<PathBuf>,
    repo_id: Option<u32>,
    localized: bool,
    stdin: Option<Vec<u8>>,
    capture_limit: Option<usize>,
    index_lock: Option<PathBuf>,
    env: Vec<(OsString, OsString)>,
}

impl GitCommand {
    /// `args` are passed as separate arguments, never through a shell.
    pub fn new<I, S>(args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        Self {
            args: args.into_iter().map(|a| a.as_ref().to_owned()).collect(),
            cwd: None,
            repo_id: None,
            localized: false,
            stdin: None,
            capture_limit: None,
            index_lock: None,
            env: Vec::new(),
        }
    }

    pub fn arg(mut self, arg: impl AsRef<OsStr>) -> Self {
        self.args.push(arg.as_ref().to_owned());
        self
    }

    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    /// Attaches the command to a repository in the log.
    pub fn repo(mut self, repo_id: u32) -> Self {
        self.repo_id = Some(repo_id);
        self
    }

    /// Keeps the user's locale (output shown verbatim, never parsed). Default is `LC_ALL=C`.
    pub fn localized(mut self) -> Self {
        self.localized = true;
        self
    }

    /// Data written to the command's stdin (a patch, a message, NUL-separated paths). Without
    /// it, stdin is empty.
    pub fn stdin(mut self, data: impl Into<Vec<u8>>) -> Self {
        self.stdin = Some(data.into());
        self
    }

    /// Keeps at most `bytes` of each output stream in memory: its beginning and its end, with
    /// a marker where the middle was dropped (`GitRun::truncated`). For output shown to the
    /// user (hooks) that a runaway process could make unbounded; never for parsed output.
    pub fn capture_limit(mut self, bytes: usize) -> Self {
        self.capture_limit = Some(bytes);
        self
    }

    /// An environment variable for this command only, set after yaggui's controlled
    /// environment: it may replace `GIT_SEQUENCE_EDITOR` with another non-interactive one
    /// (interactive rebase), never with something that waits for the user.
    pub fn env(mut self, name: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((name.into(), value.into()));
        self
    }

    /// The `index.lock` the command may take. If the command is cancelled, git is killed
    /// with its process tree (on Windows always abruptly, on Unix when it ignores SIGTERM)
    /// and cannot remove the lock: one created while it ran is removed then.
    pub fn index_lock(mut self, path: impl Into<PathBuf>) -> Self {
        self.index_lock = Some(path.into());
        self
    }
}

/// Complete result of a command that ran to its end, successful or not.
#[derive(Debug, Clone)]
pub struct GitRun {
    pub exit_code: Option<i32>,
    pub success: bool,
    /// Full output (the log keeps a bounded copy), unless the command set a
    /// [`capture_limit`](GitCommand::capture_limit).
    pub stdout: String,
    pub stderr: String,
    /// The middle of stdout or stderr was dropped (`capture_limit`).
    pub truncated: bool,
}

/// Successful command output.
#[derive(Debug, Clone)]
pub struct GitOutput {
    pub stdout: String,
    pub stderr: String,
}

/// Spawns `git`, logs every run and emits `command-logged`.
pub struct GitCli {
    /// Replaceable at runtime: the Git path is a preference (F-322).
    binary: RwLock<PathBuf>,
    log: Arc<CommandLog>,
    sink: Arc<dyn EventSink>,
    env: Vec<(OsString, OsString)>,
}

impl GitCli {
    pub fn new(log: Arc<CommandLog>, sink: Arc<dyn EventSink>) -> Self {
        Self::with_binary(DEFAULT_GIT, log, sink)
    }

    pub fn with_binary(
        binary: impl Into<PathBuf>,
        log: Arc<CommandLog>,
        sink: Arc<dyn EventSink>,
    ) -> Self {
        Self {
            binary: RwLock::new(binary.into()),
            log,
            sink,
            env: Vec::new(),
        }
    }

    /// Adds an environment variable to every command (tests isolate the Git configuration).
    pub fn with_env(mut self, name: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((name.into(), value.into()));
        self
    }

    pub fn log(&self) -> &CommandLog {
        &self.log
    }

    /// Binary used by the next commands: `git` (looked up on the `PATH`) or a configured path.
    pub fn binary(&self) -> PathBuf {
        self.binary
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Switches to another binary. Callers check it with [`probe`](Self::probe) first.
    pub fn set_binary(&self, binary: impl Into<PathBuf>) {
        *self.binary.write().unwrap_or_else(PoisonError::into_inner) = binary.into();
    }

    /// Runs `<binary> --version` and returns the version, without switching to that binary.
    /// Errors when the file does not exist, is not executable or is not Git.
    pub fn probe(&self, binary: &Path) -> Result<String, YagguiError> {
        let probe = Self {
            binary: RwLock::new(binary.to_path_buf()),
            log: Arc::clone(&self.log),
            sink: Arc::clone(&self.sink),
            env: self.env.clone(),
        };
        let shown = binary.display().to_string();
        // Whatever the failure (missing file, not executable, not Git), the path is the problem.
        let output = probe
            .run(&GitCommand::new(["--version"]))
            .map_err(|err| YagguiError::git_binary_invalid(&shown, err.detail))?;
        parse_git_version(&output.stdout)
            .ok_or_else(|| YagguiError::git_binary_invalid(&shown, Some(output.stdout)))
    }

    /// Version of the `git` binary (e.g. `2.43.0`), `None` if it is missing or unusable.
    pub fn version(&self) -> Option<String> {
        match self.run(&GitCommand::new(["--version"])) {
            Ok(output) => parse_git_version(&output.stdout),
            Err(err) => {
                tracing::warn!(error = %err, "git version detection failed");
                None
            }
        }
    }

    /// Runs a command to completion. A non-zero exit is mapped through the error catalog.
    pub fn run(&self, command: &GitCommand) -> Result<GitOutput, YagguiError> {
        self.run_with(command, None, None)
    }

    /// Like [`run`](Self::run), with cancellation and progress reporting. Progress is parsed from
    /// stderr, so the command must request it (`--progress`) when Git is not on a TTY.
    pub fn run_with(
        &self,
        command: &GitCommand,
        cancel: Option<&CancelToken>,
        on_progress: Option<&mut dyn FnMut(GitProgress)>,
    ) -> Result<GitOutput, YagguiError> {
        let run = self.run_raw(command, cancel, on_progress)?;
        if run.success {
            Ok(GitOutput {
                stdout: run.stdout,
                stderr: run.stderr,
            })
        } else {
            let (stderr, _) = bounded_output(run.stderr.as_bytes());
            // Only `git commit` reports on stdout (`nothing to commit`); it classifies its
            // output itself. Elsewhere stdout is data that must not match a pattern.
            Err(classify_git_failure(
                &stderr,
                "",
                command
                    .cwd
                    .as_deref()
                    .map(|p| p.display().to_string())
                    .as_deref(),
                command.repo_id,
            ))
        }
    }

    /// Runs a command to its end and returns its complete output, whatever its exit code:
    /// callers that interpret failures themselves (hooks) use it. Errors are only for a
    /// command that could not run (spawn failure, cancellation).
    ///
    /// A cancelled command is asked to stop, then killed with every process it started
    /// (a hook and its children): its process group on Unix, its job object on Windows.
    pub fn run_raw(
        &self,
        command: &GitCommand,
        cancel: Option<&CancelToken>,
        mut on_progress: Option<&mut dyn FnMut(GitProgress)>,
    ) -> Result<GitRun, YagguiError> {
        let started_at = unix_seconds();
        let start = Instant::now();
        let mut entry = CommandLogEntry {
            id: 0,
            repo_id: command.repo_id,
            args: command
                .args
                .iter()
                .map(|a| redact_urls(&a.to_string_lossy()).into_owned())
                .collect(),
            cwd: command.cwd.as_deref().map(|p| p.display().to_string()),
            started_at,
            duration_ms: 0,
            exit_code: None,
            status: CommandStatus::SpawnFailed,
            stdout: String::new(),
            stderr: String::new(),
            truncated: false,
        };

        if cancel.is_some_and(CancelToken::is_cancelled) {
            entry.status = CommandStatus::Cancelled;
            self.record(entry);
            return Err(YagguiError::cancelled());
        }

        let spawned_at = SystemTime::now();
        let mut child = match self.build(command).spawn() {
            Ok(child) => child,
            Err(err) => {
                entry.stderr = redact_urls(&err.to_string()).into_owned();
                entry.duration_ms = elapsed_ms(start);
                self.record(entry);
                return Err(if err.kind() == std::io::ErrorKind::NotFound {
                    YagguiError::git_not_found().with_detail(err.to_string())
                } else {
                    BackendError::io("failed to start git", err).into()
                });
            }
        };
        let tree = ProcessTree::attach(&child);

        let stdin_writer = command.stdin.clone().and_then(|data| {
            let mut pipe = child.stdin.take()?;
            // A thread, so a command that does not read its input cannot block us.
            Some(thread::spawn(move || {
                let _ = pipe.write_all(&data);
            }))
        });
        let limit = command.capture_limit;
        let stdout_reader = spawn_reader(child.stdout.take(), limit);
        let (line_tx, line_rx) = mpsc::channel::<String>();
        let stderr_reader = spawn_stderr_reader(child.stderr.take(), line_tx, limit);

        let wait = wait_child(&mut child, &tree, cancel, &line_rx, &mut on_progress);
        let cancelled = matches!(wait, Ok(WaitOutcome::Cancelled));
        // Processes left by the command (a hook's background job) may keep the pipes open.
        // Git has exited: its status stands (a commit that went through is never reported
        // as cancelled); the wait for the pipes is only bounded, and a cancellation kills
        // what is left.
        let detached =
            !cancelled && !await_readers(&[&stdout_reader, &stderr_reader], &tree, cancel);
        let stdout_capture = collect(stdout_reader, cancelled || detached);
        let stderr_capture = collect(stderr_reader, cancelled || detached);
        // Drain the lines emitted right before exit only now: until the reader has reached
        // the end of the pipe, the last ones may not be sent yet.
        while let Ok(line) = line_rx.try_recv() {
            forward_progress(&line, &mut on_progress);
        }
        let output_truncated = stdout_capture.dropped > 0 || stderr_capture.dropped > 0;
        // Masked before truncation, so a cut cannot leave the start of a secret behind.
        // `stdout` stays raw for callers: it is data (`git config` values), never displayed as is.
        let stdout_bytes = stdout_capture.into_bytes();
        let stderr_bytes = redact_urls(&String::from_utf8_lossy(&stderr_capture.into_bytes()))
            .into_owned()
            .into_bytes();
        let stdout_logged = redact_urls(&String::from_utf8_lossy(&stdout_bytes)).into_owned();
        if let Some(writer) = stdin_writer
            && writer.is_finished()
        {
            let _ = writer.join();
        }

        let (stdout, stdout_truncated) = bounded_output(stdout_logged.as_bytes());
        let (mut stderr, stderr_truncated) = bounded_output(&stderr_bytes);
        if cancelled
            && let Some(lock) = &command.index_lock
            && remove_lock_left_by_kill(lock, spawned_at)
        {
            stderr.push_str("\n[yaggui] removed the index.lock left by the cancelled command\n");
        }
        entry.stdout = stdout;
        entry.stderr = stderr;
        entry.truncated = stdout_truncated || stderr_truncated || output_truncated;
        entry.duration_ms = elapsed_ms(start);

        let result = match wait {
            Err(err) => {
                entry.status = CommandStatus::Failed;
                Err(BackendError::io("failed to wait for git", err).into())
            }
            Ok(_) if cancelled => {
                entry.status = CommandStatus::Cancelled;
                Err(YagguiError::cancelled())
            }
            Ok(WaitOutcome::Cancelled) => unreachable_cancel(),
            Ok(WaitOutcome::Exited(status)) => {
                entry.exit_code = status.code();
                entry.status = if status.success() {
                    CommandStatus::Success
                } else {
                    CommandStatus::Failed
                };
                Ok(GitRun {
                    exit_code: status.code(),
                    success: status.success(),
                    stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
                    stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
                    truncated: output_truncated,
                })
            }
        };
        self.record(entry);
        result
    }

    fn build(&self, command: &GitCommand) -> Command {
        let mut cmd = Command::new(self.binary());
        // Hooks run with this `PATH` (husky needs `npx`).
        crate::system::shell_env::apply(&mut cmd);
        for name in INHERITED_GIT_ENV {
            cmd.env_remove(name);
        }
        // `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` pairs go with `GIT_CONFIG_COUNT`.
        for (name, _) in std::env::vars_os() {
            let name = name.to_string_lossy();
            if name.starts_with("GIT_CONFIG_KEY_") || name.starts_with("GIT_CONFIG_VALUE_") {
                cmd.env_remove(name.as_ref());
            }
        }
        cmd.envs(self.env.iter().map(|(k, v)| (k, v)));
        cmd.args(&command.args)
            .env("GIT_TERMINAL_PROMPT", "0")
            // `:` is special-cased by Git as "do not launch an editor".
            .env("GIT_EDITOR", ":")
            .env("GIT_SEQUENCE_EDITOR", ":")
            .env("GIT_MERGE_AUTOEDIT", "no")
            .stdin(if command.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if !command.localized {
            cmd.env("LC_ALL", "C").env("LANGUAGE", "C");
        }
        cmd.envs(command.env.iter().map(|(k, v)| (k, v)));
        if let Some(cwd) = &command.cwd {
            cmd.current_dir(cwd);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // A new session, without a controlling terminal: when yaggui is started from a
            // terminal, `ssh` (fetch, push…) would otherwise ask for a key passphrase or a host
            // key confirmation on `/dev/tty` and wait there until cancelled.
            // `GIT_TERMINAL_PROMPT=0` only covers git's own prompts. Without a terminal, ssh
            // fails at once (or uses the user's own `SSH_ASKPASS`), and ssh-agent still works.
            // The session leader also leads a new process group whose id is its pid, which is
            // what `ProcessTree` signals on cancellation (it reaches the hooks git runs).
            // SAFETY: `setsid` is async-signal-safe and touches no memory of the parent.
            unsafe {
                cmd.pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW: git gets no console (none flashes for each call, none is
            // inherited from a terminal yaggui was started from). Git for Windows then starts
            // ssh without a console either, so ssh cannot prompt for a passphrase.
            cmd.creation_flags(0x0800_0000);
        }
        cmd
    }

    fn record(&self, entry: CommandLogEntry) {
        tracing::debug!(
            args = ?entry.args,
            status = ?entry.status,
            duration_ms = entry.duration_ms,
            "git command"
        );
        let stored = self.log.push(entry);
        self.sink
            .emit(BackendEvent::CommandLogged(CommandLogged { entry: stored }));
    }
}

enum WaitOutcome {
    Exited(ExitStatus),
    Cancelled,
}

fn wait_child(
    child: &mut Child,
    tree: &ProcessTree,
    cancel: Option<&CancelToken>,
    lines: &mpsc::Receiver<String>,
    on_progress: &mut Option<&mut dyn FnMut(GitProgress)>,
) -> std::io::Result<WaitOutcome> {
    if cancel.is_none() && on_progress.is_none() {
        return child.wait().map(WaitOutcome::Exited);
    }
    loop {
        if cancel.is_some_and(CancelToken::is_cancelled) {
            tree.terminate(child);
            return Ok(WaitOutcome::Cancelled);
        }
        // Waiting on the progress channel doubles as the poll delay.
        match lines.recv_timeout(POLL_INTERVAL) {
            Ok(line) => forward_progress(&line, on_progress),
            Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => {
                if let Some(status) = child.try_wait()? {
                    return Ok(WaitOutcome::Exited(status));
                }
                // Once stderr is closed, recv_timeout returns immediately: avoid a busy loop.
                if lines_disconnected(lines) {
                    thread::sleep(POLL_INTERVAL);
                }
            }
        }
    }
}

fn unreachable_cancel() -> Result<GitRun, YagguiError> {
    // `cancelled` is set whenever the wait outcome is `Cancelled`.
    Err(YagguiError::cancelled())
}

/// Waits until every reader reached the end of its pipe. Returns `true` if cancelled meanwhile
/// (the remaining processes are then killed).
/// Waits for the output pipes to close after the command exited: `false` when they are
/// still open after `PIPES_GRACE` or the operation was cancelled (what is left is killed).
fn await_readers(
    readers: &[&thread::JoinHandle<Capture>],
    tree: &ProcessTree,
    cancel: Option<&CancelToken>,
) -> bool {
    let start = Instant::now();
    while !readers.iter().all(|r| r.is_finished()) {
        if cancel.is_some_and(CancelToken::is_cancelled) {
            tree.kill_remaining();
            return false;
        }
        if start.elapsed() > PIPES_GRACE {
            tracing::warn!("a process started by git keeps its output open; not waiting for it");
            return false;
        }
        thread::sleep(POLL_INTERVAL);
    }
    true
}

/// The processes a command started, so a cancellation stops all of them.
struct ProcessTree {
    #[cfg(unix)]
    group: libc::pid_t,
    #[cfg(windows)]
    job: Option<windows_job::Job>,
}

impl ProcessTree {
    #[cfg(unix)]
    fn attach(child: &Child) -> Self {
        // The child leads its own session and group (`setsid` in `build`): its pid is the group id.
        Self {
            group: libc::pid_t::try_from(child.id()).unwrap_or(0),
        }
    }

    #[cfg(windows)]
    fn attach(child: &Child) -> Self {
        Self {
            job: windows_job::Job::assign(child),
        }
    }

    #[cfg(not(any(unix, windows)))]
    fn attach(_child: &Child) -> Self {
        Self {}
    }

    /// Asks the whole tree to stop (git removes its locks), then kills what is left.
    fn terminate(&self, child: &mut Child) {
        #[cfg(unix)]
        {
            self.signal(libc::SIGTERM);
            let start = Instant::now();
            while start.elapsed() < TERMINATE_GRACE {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    break;
                }
                thread::sleep(POLL_INTERVAL);
            }
        }
        self.kill_remaining();
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Kills every process of the tree still running.
    fn kill_remaining(&self) {
        #[cfg(unix)]
        self.signal(libc::SIGKILL);
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
        }
    }

    #[cfg(unix)]
    fn signal(&self, signal: libc::c_int) {
        if self.group <= 0 {
            return;
        }
        // SAFETY: `kill` has no memory-safety preconditions. The group id stays reserved
        // while any of its processes lives, so it cannot designate unrelated processes.
        unsafe {
            libc::kill(-self.group, signal);
        }
    }
}

#[cfg(windows)]
mod windows_job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject,
    };

    /// A job object holding a git process and everything it starts.
    pub struct Job(HANDLE);

    // The handle is only used through thread-safe Win32 calls.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        /// `None` if the job cannot be created or the process assigned (cancellation then
        /// only kills git itself).
        pub fn assign(child: &Child) -> Option<Self> {
            // SAFETY: null attributes and name are allowed; the handle is owned by `Job`.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return None;
            }
            let job = Self(handle);
            // SAFETY: both handles are valid for the duration of the call.
            let assigned =
                unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) };
            (assigned != 0).then_some(job)
        }

        pub fn terminate(&self) {
            // SAFETY: the job handle is valid until drop.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: owned handle, closed once. Closing does not kill the processes.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

fn lines_disconnected(lines: &mpsc::Receiver<String>) -> bool {
    matches!(lines.try_recv(), Err(mpsc::TryRecvError::Disconnected))
}

fn forward_progress(line: &str, on_progress: &mut Option<&mut dyn FnMut(GitProgress)>) {
    if let Some(callback) = on_progress.as_mut()
        && let Some(progress) = parse_progress_line(line)
    {
        callback(progress);
    }
}

/// Timestamps may be coarse (FAT: 2 s): a lock written right after the spawn can look older.
const LOCK_CLOCK_SLACK: Duration = Duration::from_secs(2);

/// Removes `lock` if it was created while the killed command ran: git takes its locks
/// exclusively, so no other process could create it in that time. A lock older than the
/// command belongs to someone else (and made the command fail, not hang): it is kept.
fn remove_lock_left_by_kill(lock: &std::path::Path, spawned_at: SystemTime) -> bool {
    let Ok(modified) = std::fs::metadata(lock).and_then(|m| m.modified()) else {
        return false;
    };
    let since = spawned_at
        .checked_sub(LOCK_CLOCK_SLACK)
        .unwrap_or(spawned_at);
    if modified < since || modified > SystemTime::now() {
        return false;
    }
    match std::fs::remove_file(lock) {
        Ok(()) => {
            tracing::warn!(lock = %lock.display(), "removed the lock left by a cancelled command");
            true
        }
        Err(err) => {
            tracing::warn!(lock = %lock.display(), error = %err, "cannot remove the lock left by a cancelled command");
            false
        }
    }
}

/// Joins a reader thread. After a cancellation, gives up after `CANCEL_GRACE` and leaves
/// the thread to finish on its own when the last pipe holder exits.
fn collect(reader: thread::JoinHandle<Capture>, cancelled: bool) -> Capture {
    if cancelled {
        let start = Instant::now();
        while !reader.is_finished() {
            if start.elapsed() > CANCEL_GRACE {
                return Capture::new(None);
            }
            thread::sleep(POLL_INTERVAL);
        }
    }
    reader.join().unwrap_or_else(|_| Capture::new(None))
}

/// Output of one stream: everything, or with a limit its first and last bytes.
#[derive(Debug)]
struct Capture {
    limit: Option<usize>,
    head: Vec<u8>,
    /// Ring of the last bytes once `head` is full (`tail_start` is its oldest byte).
    tail: Vec<u8>,
    tail_start: usize,
    dropped: u64,
}

/// Inserted where the middle of a bounded output was dropped.
const CUT_MARKER: &[u8] = b"\n[...]\n";

impl Capture {
    fn new(limit: Option<usize>) -> Self {
        Self {
            limit,
            head: Vec::new(),
            tail: Vec::new(),
            tail_start: 0,
            dropped: 0,
        }
    }

    fn push(&mut self, mut bytes: &[u8]) {
        let Some(limit) = self.limit else {
            self.head.extend_from_slice(bytes);
            return;
        };
        let head_max = limit / 2;
        let tail_max = limit - head_max;
        let room = head_max.saturating_sub(self.head.len());
        let taken = room.min(bytes.len());
        self.head.extend_from_slice(&bytes[..taken]);
        bytes = &bytes[taken..];
        for &byte in bytes {
            if self.tail.len() < tail_max {
                self.tail.push(byte);
            } else if tail_max > 0 {
                self.tail[self.tail_start] = byte;
                self.tail_start = (self.tail_start + 1) % tail_max;
                self.dropped += 1;
            } else {
                self.dropped += 1;
            }
        }
    }

    fn into_bytes(mut self) -> Vec<u8> {
        self.tail.rotate_left(self.tail_start);
        if self.dropped > 0 {
            self.head.extend_from_slice(CUT_MARKER);
        }
        self.head.extend_from_slice(&self.tail);
        self.head
    }
}

fn spawn_reader<R: Read + Send + 'static>(
    source: Option<R>,
    limit: Option<usize>,
) -> thread::JoinHandle<Capture> {
    thread::spawn(move || {
        let mut capture = Capture::new(limit);
        let Some(mut source) = source else {
            return capture;
        };
        let mut chunk = [0u8; 8192];
        loop {
            match source.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => capture.push(&chunk[..n]),
            }
        }
        capture
    })
}

/// Reads stderr, and forwards each `\r`- or `\n`-terminated line for progress parsing.
fn spawn_stderr_reader<R: Read + Send + 'static>(
    source: Option<R>,
    lines: mpsc::Sender<String>,
    limit: Option<usize>,
) -> thread::JoinHandle<Capture> {
    thread::spawn(move || {
        let mut capture = Capture::new(limit);
        let Some(mut source) = source else {
            return capture;
        };
        let mut chunk = [0u8; 4096];
        // The line being read; bounded too, a progress line is short.
        let mut line = Vec::new();
        loop {
            let read = match source.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            capture.push(&chunk[..read]);
            for &byte in &chunk[..read] {
                if byte == b'\r' || byte == b'\n' {
                    if !line.is_empty() {
                        let _ = lines.send(String::from_utf8_lossy(&line).into_owned());
                        line.clear();
                    }
                } else if line.len() < MAX_PROGRESS_LINE {
                    line.push(byte);
                }
            }
        }
        capture
    })
}

/// Longest stderr line forwarded for progress parsing.
const MAX_PROGRESS_LINE: usize = 4096;

/// Parses a Git progress line, e.g. `Receiving objects:  45% (450/1000), 1.2 MiB | 1 MiB/s`
/// or `remote: Enumerating objects: 5, done.`.
pub fn parse_progress_line(line: &str) -> Option<GitProgress> {
    // Git clears the line with an ANSI erase sequence before its next message.
    let line = line.trim().trim_start_matches("\u{1b}[K");
    if let Some(steps) = line
        .strip_prefix("Rebasing (")
        .and_then(|rest| rest.split_once(')'))
        .map(|(steps, _)| steps)
    {
        let (current, total) = steps.split_once('/')?;
        let (current, total): (u32, u32) = (current.parse().ok()?, total.parse().ok()?);
        let percent =
            (total > 0).then(|| u8::try_from(current.min(total) * 100 / total).unwrap_or(100));
        return Some(GitProgress {
            phase: "Rebasing".to_owned(),
            percent,
            current: Some(current),
            total: Some(total),
            bytes: None,
            bytes_per_sec: None,
        });
    }
    let line = line.strip_prefix("remote:").map_or(line, str::trim_start);
    let (phase, rest) = line.split_once(": ")?;
    // Progress phases are capitalized (`Receiving objects`), unlike `error:`/`fatal:`/`hint:`.
    if !phase.starts_with(|c: char| c.is_ascii_uppercase())
        || !phase.chars().all(|c| c.is_ascii_alphabetic() || c == ' ')
    {
        return None;
    }
    let rest = rest.trim_start();

    if let Some((percent, after)) = rest.split_once('%') {
        let percent: u8 = percent.trim().parse().ok().filter(|p| *p <= 100)?;
        let counts = after
            .trim_start()
            .strip_prefix('(')
            .and_then(|s| s.split_once(')'));
        let (current, total) = counts
            .and_then(|(inner, _)| inner.split_once('/'))
            .map(|(cur, tot)| (cur.parse().ok(), tot.parse().ok()))
            .unwrap_or((None, None));
        let (bytes, bytes_per_sec) = counts.map_or((None, None), |(_, rest)| parse_transfer(rest));
        return Some(GitProgress {
            phase: phase.to_owned(),
            percent: Some(percent),
            current,
            total,
            bytes,
            bytes_per_sec,
        });
    }

    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let current = digits.parse().ok()?;
    Some(GitProgress {
        phase: phase.to_owned(),
        percent: None,
        current: Some(current),
        total: None,
        bytes: None,
        bytes_per_sec: None,
    })
}

/// `, 1.20 MiB | 2.00 MiB/s, done.` → (bytes, bytes per second).
fn parse_transfer(rest: &str) -> (Option<u64>, Option<u64>) {
    let rest = rest.trim_start_matches([',', ' ']);
    let mut parts = rest.split('|');
    let bytes = parts.next().and_then(parse_size);
    let rate = parts
        .next()
        .and_then(|r| r.split_once("/s"))
        .and_then(|(r, _)| parse_size(r));
    (bytes, rate)
}

/// `1.20 MiB`, `250 bytes`, `12 KiB` → bytes.
fn parse_size(text: &str) -> Option<u64> {
    let mut words = text.split_whitespace();
    let value: f64 = words.next()?.parse().ok()?;
    let unit: f64 = match words.next()?.trim_end_matches([',', '.']) {
        "byte" | "bytes" => 1.0,
        "KiB" => 1024.0,
        "MiB" => 1024.0 * 1024.0,
        "GiB" => 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some((value * unit).round() as u64)
}

/// Extracts the version from `git --version` output, e.g. `git version 2.39.3 (Apple Git-145)`.
fn parse_git_version(output: &str) -> Option<String> {
    output
        .trim()
        .strip_prefix("git version ")?
        .split_whitespace()
        .next()
        .map(str::to_owned)
}

fn unix_seconds() -> u32 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u32::try_from(d.as_secs()).unwrap_or(u32::MAX))
        .unwrap_or(0)
}

fn elapsed_ms(start: Instant) -> u32 {
    u32::try_from(start.elapsed().as_millis()).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_keeps_head_and_tail() {
        let mut capture = Capture::new(Some(8));
        capture.push(b"abcdef");
        capture.push(b"ghijklmn");
        assert_eq!(capture.dropped, 6);
        let mut expected = b"abcd".to_vec();
        expected.extend_from_slice(CUT_MARKER);
        expected.extend_from_slice(b"klmn");
        assert_eq!(capture.into_bytes(), expected);

        let mut small = Capture::new(Some(8));
        small.push(b"abcdefgh");
        assert_eq!(small.dropped, 0);
        assert_eq!(small.into_bytes(), b"abcdefgh");

        let mut unbounded = Capture::new(None);
        unbounded.push(&[b'x'; 100_000]);
        assert_eq!(unbounded.into_bytes().len(), 100_000);
    }
    use crate::events::NullSink;

    fn cli() -> GitCli {
        GitCli::new(Arc::new(CommandLog::new()), Arc::new(NullSink))
    }

    #[test]
    fn parses_plain_version() {
        assert_eq!(
            parse_git_version("git version 2.43.0\n").as_deref(),
            Some("2.43.0")
        );
    }

    #[test]
    fn parses_apple_version() {
        assert_eq!(
            parse_git_version("git version 2.39.3 (Apple Git-145)").as_deref(),
            Some("2.39.3")
        );
    }

    #[test]
    fn parses_windows_version() {
        assert_eq!(
            parse_git_version("git version 2.47.1.windows.1").as_deref(),
            Some("2.47.1.windows.1")
        );
    }

    #[test]
    fn rejects_unexpected_output() {
        assert_eq!(parse_git_version("not git"), None);
        assert_eq!(parse_git_version(""), None);
    }

    #[test]
    fn compares_versions() {
        assert!(is_supported_version("2.30.0"));
        assert!(is_supported_version("2.47.1.windows.1"));
        assert!(is_supported_version("3.0"));
        assert!(!is_supported_version("2.29.2"));
        assert!(!is_supported_version("1.9"));
    }

    #[test]
    fn detects_installed_git_and_logs_it() {
        // The test environment (CI, dev machines) always has git installed.
        let cli = cli();
        assert!(cli.version().is_some());
        let entries = cli.log().entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].args, vec!["--version"]);
        assert_eq!(entries[0].status, CommandStatus::Success);
        assert_eq!(entries[0].exit_code, Some(0));
    }

    #[test]
    fn reports_missing_binary() {
        let cli = GitCli::with_binary(
            "yaggui-no-such-git",
            Arc::new(CommandLog::new()),
            Arc::new(NullSink),
        );
        let err = cli.run(&GitCommand::new(["--version"])).unwrap_err();
        assert_eq!(err.code, crate::git::errors::ErrorCode::GitNotFound);
        assert_eq!(cli.log().entries()[0].status, CommandStatus::SpawnFailed);
        assert_eq!(cli.version(), None);
    }

    #[test]
    fn maps_failures_through_the_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let cli = cli();
        let err = cli
            .run(&GitCommand::new(["status"]).cwd(dir.path()))
            .unwrap_err();
        assert_eq!(err.code, crate::git::errors::ErrorCode::NotARepository);
        let entry = &cli.log().entries()[0];
        assert_eq!(entry.status, CommandStatus::Failed);
        assert_eq!(entry.exit_code, Some(128));
        assert!(entry.stderr.contains("not a git repository"));
    }

    #[test]
    fn does_not_start_a_cancelled_command() {
        let cli = cli();
        let token = CancelToken::new();
        token.cancel();
        let err = cli
            .run_with(&GitCommand::new(["--version"]), Some(&token), None)
            .unwrap_err();
        assert_eq!(err.code, crate::git::errors::ErrorCode::Cancelled);
        assert_eq!(cli.log().entries()[0].status, CommandStatus::Cancelled);
    }

    #[test]
    fn parses_progress_with_percent() {
        assert_eq!(
            parse_progress_line("Receiving objects:  45% (450/1000), 1.20 MiB | 1.00 MiB/s"),
            Some(GitProgress {
                phase: "Receiving objects".into(),
                percent: Some(45),
                current: Some(450),
                total: Some(1000),
                bytes: Some(1_258_291),
                bytes_per_sec: Some(1_048_576),
            })
        );
        assert_eq!(
            parse_progress_line("Writing objects: 100% (3/3), 250 bytes | 250.00 KiB/s, done."),
            Some(GitProgress {
                phase: "Writing objects".into(),
                percent: Some(100),
                current: Some(3),
                total: Some(3),
                bytes: Some(250),
                bytes_per_sec: Some(256_000),
            })
        );
    }

    #[test]
    fn parses_remote_progress() {
        assert_eq!(
            parse_progress_line("remote: Compressing objects: 100% (3/3), done."),
            Some(GitProgress {
                phase: "Compressing objects".into(),
                percent: Some(100),
                current: Some(3),
                total: Some(3),
                bytes: None,
                bytes_per_sec: None,
            })
        );
        assert_eq!(
            parse_progress_line("remote: Enumerating objects: 5, done."),
            Some(GitProgress {
                phase: "Enumerating objects".into(),
                percent: None,
                current: Some(5),
                total: None,
                bytes: None,
                bytes_per_sec: None,
            })
        );
    }

    #[test]
    fn parses_rebase_steps() {
        assert_eq!(
            parse_progress_line("Rebasing (3/7)"),
            Some(GitProgress {
                phase: "Rebasing".into(),
                percent: Some(42),
                current: Some(3),
                total: Some(7),
                bytes: None,
                bytes_per_sec: None,
            })
        );
        assert_eq!(parse_progress_line("Rebasing (x/7)"), None);
    }

    #[test]
    fn ignores_non_progress_lines() {
        assert_eq!(parse_progress_line("From /tmp/remote"), None);
        assert_eq!(
            parse_progress_line(" * [new branch]      main       -> origin/main"),
            None
        );
        assert_eq!(parse_progress_line("fatal: repository not found"), None);
        assert_eq!(parse_progress_line("error: 3 files: oops"), None);
    }
}
