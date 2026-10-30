//! Diagnostics beyond the command log: one log file per session in the OS log folder, a crash
//! report for each Rust panic, the frontend's uncaught errors, and the bug report the user copies.
//!
//! Nothing leaves the machine: the user reads the report and pastes it where they choose.

use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use specta::Type;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, fmt};

/// Overrides the log folder (tests, several profiles side by side).
pub const LOG_DIR_ENV: &str = "YAGGUI_LOG_DIR";
const LOG_FILE: &str = "yaggui.log";
/// `yaggui.log` (this session), `yaggui.1.log` (the previous one)… up to `yaggui.4.log`.
const KEPT_SESSIONS: usize = 5;
/// One session never writes more: a loop that logs on every frame must not fill the disk.
const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;
const LIMIT_NOTE: &str =
    "[yaggui] log size limit reached: later entries of this session are not written\n";
/// What is kept of the lines logged before the folder is known (Tauri gives it in `setup`).
const EARLY_BUFFER_BYTES: usize = 64 * 1024;
const CRASH_PREFIX: &str = "crash-";
const CRASH_EXT: &str = ".txt";
const KEPT_CRASHES: usize = 10;
/// Holds the name of the newest crash report the user was told about.
const CRASHES_SEEN: &str = "crashes-seen";
/// A crash older than this is not added to the bug report.
const RECENT_CRASH: Duration = Duration::from_secs(7 * 24 * 3600);

const FRONTEND_MESSAGE_MAX: usize = 2_000;
const FRONTEND_STACK_MAX: usize = 8_000;
const REPORT_LINE_MAX: usize = 500;
const CURRENT_LOG_LINES: usize = 150;
const PREVIOUS_LOG_LINES: usize = 100;
/// Bytes read from the end of a log to find its last lines.
const TAIL_BYTES: u64 = 256 * 1024;
const CRASH_IN_REPORT_MAX: usize = 8_000;

enum Sink {
    Early(Vec<u8>),
    File {
        file: File,
        written: u64,
    },
    /// Size limit reached, or no file could be opened.
    Off,
}

static SINK: Mutex<Sink> = Mutex::new(Sink::Early(Vec::new()));
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
/// The file of this session: `yaggui.log`, or `yaggui-<pid>.log` when another running copy
/// holds it on Windows.
static SESSION_LOG: OnceLock<PathBuf> = OnceLock::new();

/// A panic while a line is written only leaves a half-written line behind.
fn lock_sink() -> MutexGuard<'static, Sink> {
    SINK.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Writes formatted events to the session file. The fmt layer hands over one whole event per
/// `write`, so lines from different threads never interleave. Never fails: losing a log line
/// must not break what was being logged. Nothing in here may log, the sink is locked.
struct LogWriter;

impl Write for LogWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut sink = lock_sink();
        let full = match &mut *sink {
            Sink::Early(pending) => {
                if pending.len() + buf.len() <= EARLY_BUFFER_BYTES {
                    pending.extend_from_slice(buf);
                }
                false
            }
            Sink::File { file, written } => {
                if *written + buf.len() as u64 > MAX_LOG_BYTES {
                    let _ = file.write_all(LIMIT_NOTE.as_bytes());
                    true
                } else {
                    if file.write_all(buf).is_ok() {
                        *written += buf.len() as u64;
                    }
                    false
                }
            }
            Sink::Off => false,
        };
        if full {
            *sink = Sink::Off;
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Logs to stderr, as before, and to the session file once [`attach_log_dir`] gives its folder.
/// `RUST_LOG` filters both (`info` by default).
pub fn init_logging() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer())
        .with(fmt::layer().with_ansi(false).with_writer(|| LogWriter))
        .init();
}

/// The OS log folder (`~/Library/Logs/dev.tropico.yaggui`, `~/.local/share/dev.tropico.yaggui/logs`,
/// `%LOCALAPPDATA%\dev.tropico.yaggui\logs`), unless `YAGGUI_LOG_DIR` overrides it.
pub fn log_dir(app_log_dir: PathBuf) -> PathBuf {
    std::env::var_os(LOG_DIR_ENV).map_or(app_log_dir, PathBuf::from)
}

/// The folder given to [`attach_log_dir`], once known.
pub fn current_log_dir() -> Option<&'static Path> {
    LOG_DIR.get().map(PathBuf::as_path)
}

/// Starts this session's log file in `dir` (the previous sessions shift by one), writes what
/// was logged so far into it, and removes the oldest crash reports.
pub fn attach_log_dir(dir: &Path) {
    if LOG_DIR.set(dir.to_path_buf()).is_err() {
        return;
    }
    let opened = fs::create_dir_all(dir).and_then(|()| open_session_log(dir));
    let mut sink = lock_sink();
    let pending = match std::mem::replace(&mut *sink, Sink::Off) {
        Sink::Early(pending) => pending,
        _ => Vec::new(),
    };
    let failure = match opened {
        Ok((mut file, path)) => {
            let _ = SESSION_LOG.set(path);
            let written = file
                .write_all(&pending)
                .map_or(0, |()| pending.len() as u64);
            *sink = Sink::File { file, written };
            None
        }
        Err(err) => Some(err),
    };
    drop(sink);
    match failure {
        None => tracing::info!(
            version = env!("CARGO_PKG_VERSION"),
            os = std::env::consts::OS,
            arch = std::env::consts::ARCH,
            path = %dir.display(),
            "log folder"
        ),
        Some(err) => {
            tracing::warn!(path = %dir.display(), error = %err, "no log file for this session")
        }
    }
    prune_crash_reports(dir);
}

fn session_log_name(index: usize) -> String {
    if index == 0 {
        LOG_FILE.to_owned()
    } else {
        format!("yaggui.{index}.log")
    }
}

/// Shifts the previous sessions, then creates `yaggui.log`. Another running copy keeps the
/// file open: on Windows it cannot be renamed, so this session writes its own file instead.
fn open_session_log(dir: &Path) -> io::Result<(File, PathBuf)> {
    let rotated = (1..KEPT_SESSIONS).rev().try_for_each(|index| {
        let from = dir.join(session_log_name(index - 1));
        if from.exists() {
            fs::rename(&from, dir.join(session_log_name(index)))
        } else {
            Ok(())
        }
    });
    let path = match rotated {
        Ok(()) => dir.join(LOG_FILE),
        Err(_) => dir.join(format!("yaggui-{}.log", std::process::id())),
    };
    Ok((File::create(&path)?, path))
}

/// Records every panic in the log and in a crash report of the log folder, then lets the
/// default hook print it as before. A panic on a background thread does not stop the app:
/// without this, it would leave no trace once the terminal is gone.
pub fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info.payload_as_str().unwrap_or("(no message)").to_owned();
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_default();
        let current = std::thread::current();
        let thread = current.name().unwrap_or("unnamed");
        tracing::error!(%message, %location, thread, "panic");
        if let Some(dir) = current_log_dir() {
            let backtrace = std::backtrace::Backtrace::force_capture().to_string();
            let crash = Crash {
                message: &message,
                location: &location,
                thread,
                backtrace: &backtrace,
            };
            let _ = write_crash_report(dir, &crash, SystemTime::now());
        }
        default(info);
    }));
}

struct Crash<'a> {
    message: &'a str,
    location: &'a str,
    thread: &'a str,
    backtrace: &'a str,
}

fn crash_text(crash: &Crash<'_>, at: SystemTime) -> String {
    format!(
        "yaggui crash report\nversion: {}\nos: {} ({})\ntime: {}\nthread: {}\nlocation: {}\nmessage: {}\n\nbacktrace:\n{}\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        utc_timestamp(unix_secs(at)),
        crash.thread,
        crash.location,
        crash.message,
        crash.backtrace,
    )
}

/// `crash-<unix ms, 13 digits>-<pid>.txt`: names sort by date.
fn write_crash_report(dir: &Path, crash: &Crash<'_>, at: SystemTime) -> io::Result<PathBuf> {
    let millis = at
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = dir.join(format!(
        "{CRASH_PREFIX}{millis:013}-{}{CRASH_EXT}",
        std::process::id()
    ));
    fs::write(&path, crash_text(crash, at))?;
    Ok(path)
}

/// Crash report names, oldest first.
fn crash_reports(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| entry.file_name().into_string().ok())
                .filter(|name| name.starts_with(CRASH_PREFIX) && name.ends_with(CRASH_EXT))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

fn prune_crash_reports(dir: &Path) {
    let names = crash_reports(dir);
    let excess = names.len().saturating_sub(KEPT_CRASHES);
    for name in &names[..excess] {
        if let Err(err) = fs::remove_file(dir.join(name)) {
            tracing::warn!(file = %name, error = %err, "cannot remove an old crash report");
        }
    }
}

/// Unix time in seconds of a crash report, read from its name.
fn crash_time(name: &str) -> Option<u64> {
    let millis = name.strip_prefix(CRASH_PREFIX)?.split('-').next()?;
    millis.parse::<u64>().ok().map(|ms| ms / 1000)
}

/// A crash report the user has not been told about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CrashSummary {
    pub file: String,
    /// Seconds since the Unix epoch.
    pub at: u32,
    /// First line of the panic message.
    pub message: String,
}

fn summary(dir: &Path, name: &str) -> CrashSummary {
    let text = fs::read_to_string(dir.join(name)).unwrap_or_default();
    let message = text
        .lines()
        .find_map(|line| line.strip_prefix("message: "))
        .unwrap_or_default();
    CrashSummary {
        file: dir.join(name).display().to_string(),
        at: crash_time(name).map_or(0, |secs| u32::try_from(secs).unwrap_or(u32::MAX)),
        message: truncate(message, REPORT_LINE_MAX).to_owned(),
    }
}

/// Crash reports newer than the last ones acknowledged, oldest first.
pub fn pending_crashes(dir: &Path) -> Vec<CrashSummary> {
    let seen = fs::read_to_string(dir.join(CRASHES_SEEN)).unwrap_or_default();
    let seen = seen.trim();
    crash_reports(dir)
        .iter()
        .filter(|name| name.as_str() > seen)
        .map(|name| summary(dir, name))
        .collect()
}

/// The user was told about every crash report there is now.
pub fn acknowledge_crashes(dir: &Path) -> io::Result<()> {
    match crash_reports(dir).last() {
        Some(newest) => fs::write(dir.join(CRASHES_SEEN), newest),
        None => Ok(()),
    }
}

/// An uncaught error of the frontend (React render, `window.onerror`, unhandled rejection),
/// so that it lands in the session log next to what the backend did.
pub fn log_frontend_error(kind: &str, message: &str, stack: Option<&str>) {
    let kind = truncate(kind, 40);
    let message = truncate(message, FRONTEND_MESSAGE_MAX);
    let stack = stack.map_or("", |stack| truncate(stack, FRONTEND_STACK_MAX));
    tracing::error!(target: "yaggui::frontend", kind, message, stack, "frontend error");
}

/// `text` cut to at most `max` bytes, on a character boundary.
fn truncate(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// The last `max_lines` lines of a file, each cut to `REPORT_LINE_MAX` bytes.
fn tail_lines(path: &Path, max_lines: usize) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<&str> = text.lines().collect();
    if start > 0 && !lines.is_empty() {
        // Read from the middle of a line.
        lines.remove(0);
    }
    let skip = lines.len().saturating_sub(max_lines);
    let mut out = String::new();
    for line in &lines[skip..] {
        let cut = truncate(line, REPORT_LINE_MAX);
        out.push_str(cut);
        if cut.len() < line.len() {
            out.push('…');
        }
        out.push('\n');
    }
    Some(out)
}

/// What the bug report says about the machine; gathered by the caller.
#[derive(Debug, Clone, Default)]
pub struct Environment {
    pub app_version: String,
    pub install: String,
    pub os: String,
    pub webview: Option<String>,
    pub git_version: Option<String>,
    pub git_path: Option<String>,
}

/// A fence longer than any run of backticks in `text`, so the block cannot be closed early.
fn fence(text: &str) -> String {
    let longest = text.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    "`".repeat((longest + 1).max(3))
}

fn push_block(out: &mut String, title: &str, text: &str) {
    let fence = fence(text);
    let _ = write!(
        out,
        "\n<details>\n<summary>{title}</summary>\n\n{fence}text\n{}\n{fence}\n\n</details>\n",
        text.trim_end()
    );
}

/// The Markdown the user pastes into a bug report: environment, the most recent crash report
/// of the last week, the end of this session's log and of the previous one.
pub fn bug_report(dir: &Path, env: &Environment, now: SystemTime) -> String {
    let mut out = String::from("### Environment\n\n| | |\n|---|---|\n");
    let unknown = "unknown".to_owned();
    let git = match (&env.git_version, &env.git_path) {
        (Some(version), Some(path)) => format!("{version} (`{path}`)"),
        (Some(version), None) => version.clone(),
        (None, Some(path)) => format!("not working (`{path}`)"),
        (None, None) => "not found".to_owned(),
    };
    let _ = writeln!(out, "| yaggui | {} ({}) |", env.app_version, env.install);
    let _ = writeln!(out, "| OS | {} |", env.os);
    let _ = writeln!(
        out,
        "| WebView | {} |",
        env.webview.as_ref().unwrap_or(&unknown)
    );
    let _ = writeln!(out, "| Git | {git} |");

    let oldest = unix_secs(now).saturating_sub(RECENT_CRASH.as_secs());
    if let Some(name) = crash_reports(dir)
        .into_iter()
        .rev()
        .find(|name| crash_time(name).is_some_and(|secs| secs >= oldest))
        && let Ok(text) = fs::read_to_string(dir.join(&name))
    {
        let cut = truncate(&text, CRASH_IN_REPORT_MAX);
        let mut shown = cut.to_owned();
        if cut.len() < text.len() {
            shown.push_str("\n…");
        }
        push_block(&mut out, &format!("Latest crash report ({name})"), &shown);
    }

    let current = SESSION_LOG
        .get()
        .cloned()
        .unwrap_or_else(|| dir.join(LOG_FILE));
    if let Some(text) = tail_lines(&current, CURRENT_LOG_LINES) {
        push_block(
            &mut out,
            &format!("Log of this session (last {CURRENT_LOG_LINES} lines)"),
            &text,
        );
    }
    if let Some(text) = tail_lines(&dir.join(session_log_name(1)), PREVIOUS_LOG_LINES) {
        push_block(
            &mut out,
            &format!("Log of the previous session (last {PREVIOUS_LOG_LINES} lines)"),
            &text,
        );
    }
    out
}

fn unix_secs(at: SystemTime) -> u64 {
    at.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

/// `2026-10-30T14:03:09Z`, from seconds since the Unix epoch (proleptic Gregorian calendar).
fn utc_timestamp(secs: u64) -> String {
    let days = secs / 86_400;
    let rem = secs % 86_400;
    // Howard Hinnant's civil_from_days, shifted to a year starting in March.
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Name and version of the OS, e.g. `macOS 15.1 (aarch64)`, `Ubuntu 24.04.1 LTS, kernel 6.8.0
/// (x86_64)`, `Microsoft Windows [Version 10.0.22631.4317] (x86_64)`.
pub fn os_description() -> String {
    let arch = std::env::consts::ARCH;
    let name = os_name().unwrap_or_else(|| std::env::consts::OS.to_owned());
    format!("{name} ({arch})")
}

#[cfg(target_os = "macos")]
fn os_name() -> Option<String> {
    let output = std::process::Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!version.is_empty()).then(|| format!("macOS {version}"))
}

#[cfg(windows)]
fn os_name() -> Option<String> {
    use std::os::windows::process::CommandExt;
    // From System32, never from the current folder or an early `PATH` entry.
    let cmd = super::terminal::windows_program(std::ffi::OsStr::new("cmd.exe"))?;
    let output = std::process::Command::new(cmd)
        .args(["/d", "/c", "ver"])
        .stdin(std::process::Stdio::null())
        // CREATE_NO_WINDOW: no console flashes.
        .creation_flags(0x0800_0000)
        .output()
        .ok()?;
    let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!version.is_empty()).then_some(version)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn os_name() -> Option<String> {
    let release = fs::read_to_string("/etc/os-release")
        .or_else(|_| fs::read_to_string("/usr/lib/os-release"))
        .ok();
    let name = release.as_deref().and_then(pretty_name);
    let kernel = fs::read_to_string("/proc/sys/kernel/osrelease")
        .ok()
        .map(|k| k.trim().to_owned());
    match (name, kernel) {
        (Some(name), Some(kernel)) => Some(format!("{name}, kernel {kernel}")),
        (Some(name), None) => Some(name),
        (None, Some(kernel)) => Some(format!("Linux {kernel}")),
        (None, None) => None,
    }
}

/// `PRETTY_NAME` of an `os-release` file, unquoted.
#[cfg_attr(any(target_os = "macos", windows), allow(dead_code))]
fn pretty_name(os_release: &str) -> Option<String> {
    os_release.lines().find_map(|line| {
        let value = line.strip_prefix("PRETTY_NAME=")?.trim();
        let value = value.trim_matches('"').trim_matches('\'');
        (!value.is_empty()).then(|| value.to_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crash<'a>(message: &'a str) -> Crash<'a> {
        Crash {
            message,
            location: "src/lib.rs:1:2",
            thread: "main",
            backtrace: "0: yaggui::run",
        }
    }

    fn at(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    #[test]
    fn utc_timestamps() {
        assert_eq!(utc_timestamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc_timestamp(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(utc_timestamp(1_793_455_389), "2026-10-31T14:03:09Z");
    }

    #[test]
    fn sessions_rotate_and_keep_five() {
        let dir = tempfile::tempdir().unwrap();
        for session in 0..7 {
            let (mut file, path) = open_session_log(dir.path()).unwrap();
            assert_eq!(path, dir.path().join(LOG_FILE));
            writeln!(file, "session {session}").unwrap();
        }
        let read = |name: &str| fs::read_to_string(dir.path().join(name)).unwrap();
        assert_eq!(read("yaggui.log"), "session 6\n");
        assert_eq!(read("yaggui.1.log"), "session 5\n");
        assert_eq!(read("yaggui.4.log"), "session 2\n");
        assert!(!dir.path().join("yaggui.5.log").exists());
    }

    #[test]
    fn crash_reports_are_pending_until_acknowledged() {
        let dir = tempfile::tempdir().unwrap();
        assert!(pending_crashes(dir.path()).is_empty());
        acknowledge_crashes(dir.path()).unwrap();

        write_crash_report(dir.path(), &crash("index out of bounds"), at(1_000)).unwrap();
        write_crash_report(dir.path(), &crash("second\nline"), at(2_000)).unwrap();
        let pending = pending_crashes(dir.path());
        assert_eq!(pending.len(), 2);
        assert_eq!(pending[0].message, "index out of bounds");
        assert_eq!(pending[0].at, 1_000);
        assert_eq!(pending[1].message, "second");

        acknowledge_crashes(dir.path()).unwrap();
        assert!(pending_crashes(dir.path()).is_empty());
        write_crash_report(dir.path(), &crash("third"), at(3_000)).unwrap();
        let pending = pending_crashes(dir.path());
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].message, "third");
    }

    #[test]
    fn old_crash_reports_are_pruned() {
        let dir = tempfile::tempdir().unwrap();
        for secs in 0..KEPT_CRASHES as u64 + 3 {
            write_crash_report(dir.path(), &crash("boom"), at(1_000 + secs)).unwrap();
        }
        prune_crash_reports(dir.path());
        let names = crash_reports(dir.path());
        assert_eq!(names.len(), KEPT_CRASHES);
        assert_eq!(names.first().and_then(|n| crash_time(n)), Some(1_003));
    }

    #[test]
    fn tail_keeps_the_last_whole_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log");
        let long = "x".repeat(REPORT_LINE_MAX + 10);
        let mut text = String::new();
        for n in 0..10 {
            let _ = writeln!(text, "line {n}");
        }
        text.push_str(&long);
        fs::write(&path, &text).unwrap();
        let tail = tail_lines(&path, 3).unwrap();
        let lines: Vec<&str> = tail.lines().collect();
        assert_eq!(lines[..2], ["line 8", "line 9"]);
        assert_eq!(lines[2], format!("{}…", "x".repeat(REPORT_LINE_MAX)));

        // Larger than what is read: the partial first line is dropped.
        let big = "y".repeat(TAIL_BYTES as usize) + "\nlast\n";
        fs::write(&path, big).unwrap();
        assert_eq!(tail_lines(&path, 10).unwrap(), "last\n");
        assert_eq!(tail_lines(&dir.path().join("missing"), 3), None);
    }

    #[test]
    fn report_lists_environment_recent_crash_and_logs() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("yaggui.log"), "now ```quoted```\n").unwrap();
        fs::write(dir.path().join("yaggui.1.log"), "before\n").unwrap();
        let now = 10 * RECENT_CRASH.as_secs();
        write_crash_report(dir.path(), &crash("too old"), at(1)).unwrap();
        let env = Environment {
            app_version: "1.2.3".into(),
            install: "manual".into(),
            os: "TestOS 1 (x86_64)".into(),
            webview: None,
            git_version: Some("2.47.0".into()),
            git_path: Some("/usr/bin/git".into()),
        };
        let report = bug_report(dir.path(), &env, at(now));
        assert!(report.contains("| yaggui | 1.2.3 (manual) |"));
        assert!(report.contains("| OS | TestOS 1 (x86_64) |"));
        assert!(report.contains("| WebView | unknown |"));
        assert!(report.contains("| Git | 2.47.0 (`/usr/bin/git`) |"));
        assert!(
            !report.contains("crash report"),
            "a crash older than a week is left out"
        );
        // The log holds a triple backtick: the block is fenced with four.
        assert!(report.contains("````text\nnow ```quoted```\n````"));
        assert!(report.contains("Log of the previous session"));

        write_crash_report(dir.path(), &crash("recent"), at(now - 60)).unwrap();
        let report = bug_report(dir.path(), &env, at(now));
        assert!(report.contains("Latest crash report (crash-"));
        assert!(report.contains("message: recent"));
    }

    #[test]
    fn fences_outgrow_the_content() {
        assert_eq!(fence("plain"), "```");
        assert_eq!(fence("a ```` b"), "`````");
    }

    #[test]
    fn os_release_pretty_name() {
        let text = "NAME=\"Ubuntu\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\nID=ubuntu\n";
        assert_eq!(pretty_name(text).as_deref(), Some("Ubuntu 24.04.1 LTS"));
        assert_eq!(pretty_name("PRETTY_NAME=NixOS\n").as_deref(), Some("NixOS"));
        assert_eq!(pretty_name("ID=arch\n"), None);
    }

    #[test]
    fn truncation_respects_characters() {
        assert_eq!(truncate("héllo", 2), "h");
        assert_eq!(truncate("short", 10), "short");
    }
}
