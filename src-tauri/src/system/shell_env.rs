//! `PATH` of the user's login shell, for the programs yaggui starts.
//!
//! A macOS app launched from the Dock or Finder (and some Linux launchers) gets the short
//! `PATH` of launchd (`/usr/bin:/bin:/usr/sbin:/sbin`), not the one the user's shell builds
//! from `.zprofile` / `.zshrc`. Git hooks then miss `node`, `npx` (Homebrew, nvm, Volta…):
//! husky fails with "command not found". Like editors and other Git clients, yaggui asks the
//! login shell for its `PATH` once, in the background at startup, and gives every child
//! process that `PATH` followed by the entries of its own that the shell does not have.

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Set in the shell's environment while yaggui reads it, so a slow `.zshrc` can skip work.
pub const RESOLVING_ENV: &str = "YAGGUI_RESOLVING_ENVIRONMENT";

/// A `.zshrc` that waits on something (tmux attach, a prompt) must not hold Git back for long.
const TIMEOUT: Duration = Duration::from_secs(5);

const START: &str = "__YAGGUI_ENV_START__";
const END: &str = "__YAGGUI_ENV_END__";

static STARTED: AtomicBool = AtomicBool::new(false);
static LOGIN_PATH: OnceLock<Option<OsString>> = OnceLock::new();

/// Starts reading the login shell's `PATH` on a background thread. Without this call (tests,
/// Windows, where GUI apps get the user's full `PATH`), children keep yaggui's own `PATH`.
pub fn resolve_in_background() {
    if cfg!(windows) || STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("shell-env".into())
        .spawn(|| {
            LOGIN_PATH.get_or_init(read_login_path);
        });
    if let Err(err) = spawned {
        tracing::warn!(%err, "could not start reading the login shell environment");
        LOGIN_PATH.get_or_init(|| None);
    }
}

/// The `PATH` to give a child process, or `None` to leave it inherited. Waits for the
/// background read when it is still running (at most [`TIMEOUT`]).
pub fn child_path() -> Option<OsString> {
    if !STARTED.load(Ordering::SeqCst) {
        return None;
    }
    let login = LOGIN_PATH.get_or_init(read_login_path).as_deref()?;
    let own = std::env::var_os("PATH").unwrap_or_default();
    Some(merge(login, &own))
}

/// Sets [`child_path`] on `command`, if there is one.
pub fn apply(command: &mut Command) {
    if let Some(path) = child_path() {
        command.env("PATH", path);
    }
}

/// `login` first, then the entries of `own` it lacks, in order and without duplicates.
fn merge(login: &OsStr, own: &OsStr) -> OsString {
    let mut seen = Vec::new();
    for dir in std::env::split_paths(login).chain(std::env::split_paths(own)) {
        if !dir.as_os_str().is_empty() && !seen.contains(&dir) {
            seen.push(dir);
        }
    }
    std::env::join_paths(seen).unwrap_or_else(|_| own.to_os_string())
}

fn read_login_path() -> Option<OsString> {
    let shell = std::env::var_os("SHELL").filter(|s| !s.is_empty())?;
    let started = std::time::Instant::now();
    let path = run_shell(&shell);
    match &path {
        Some(_) => tracing::info!(
            shell = %shell.to_string_lossy(),
            ms = started.elapsed().as_millis() as u64,
            "PATH read from the login shell"
        ),
        None => tracing::warn!(
            shell = %shell.to_string_lossy(),
            "could not read PATH from the login shell; hooks see yaggui's own PATH"
        ),
    }
    path
}

/// Runs `$SHELL -l -i -c` and prints the environment between markers: `-i` because version
/// managers (nvm, fnm) are usually set up in `.zshrc` / `.bashrc`, and markers because an
/// interactive shell may print a banner. `env` keeps it shell-agnostic (fish lists `$PATH`
/// with spaces).
fn run_shell(shell: &OsStr) -> Option<OsString> {
    let script = format!("echo {START}; command env; echo {END}");
    let mut child = Command::new(shell)
        .args(["-l", "-i", "-c", &script])
        .env(RESOLVING_ENV, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("shell-env-read".into())
        .spawn(move || {
            let mut out = Vec::new();
            let _ = stdout.read_to_end(&mut out);
            let _ = sender.send(out);
        })
        .ok()?;
    let out = match receiver.recv_timeout(TIMEOUT) {
        Ok(out) => out,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    let _ = child.wait();
    parse_path(&String::from_utf8_lossy(&out)).map(OsString::from)
}

fn parse_path(output: &str) -> Option<String> {
    let (_, rest) = output.split_once(START)?;
    let (env, _) = rest.split_once(END)?;
    env.lines()
        .find_map(|line| line.strip_prefix("PATH="))
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_path_between_the_markers() {
        let output = format!(
            "Welcome!\nPATH=/banner/only\n{START}\nHOME=/Users/me\nPATH=/opt/homebrew/bin:/usr/bin\n{END}\n"
        );
        assert_eq!(
            parse_path(&output).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[test]
    fn no_markers_or_no_path_is_none() {
        assert_eq!(parse_path("PATH=/usr/bin\n"), None);
        assert_eq!(parse_path(&format!("{START}\nHOME=/x\n{END}")), None);
        assert_eq!(parse_path(&format!("{START}\nPATH=\n{END}")), None);
    }

    #[test]
    #[cfg(unix)]
    fn login_entries_come_first_without_duplicates() {
        let merged = merge(
            OsStr::new("/opt/homebrew/bin:/usr/bin"),
            OsStr::new("/usr/bin:/bin:/opt/homebrew/bin"),
        );
        assert_eq!(merged, OsString::from("/opt/homebrew/bin:/usr/bin:/bin"));
    }

    #[test]
    #[cfg(unix)]
    fn reads_the_path_from_a_real_shell() {
        let path = run_shell(OsStr::new("/bin/sh")).expect("PATH from sh");
        assert!(!path.is_empty());
    }
}
