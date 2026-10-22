//! Opens the user's terminal in a repository (F-266).
//!
//! Not a Git command, so it does not go through `git/cli.rs`; the same rules still apply:
//! the program and its arguments are passed separately, never through a shell.
//!
//! Windows does not use `std::process::Command`: it always passes standard handles
//! (`STARTF_USESTDHANDLES`), which, from a GUI app, leaves a console program such as `cmd`
//! or `pwsh` reading EOF and exiting at once. `CreateProcessW` is called directly instead,
//! with a new console and no handle redirection; the command line and flags are computed
//! by pure functions ([`windows_command_line`], [`windows_creation_flags`]) tested on any host.

use std::ffi::OsString;
#[cfg(not(windows))]
use std::io::Read;
use std::path::Path;
#[cfg(not(windows))]
use std::process::{Command, Stdio};

use crate::git::errors::YagguiError;

/// Target OS of a resolution; a parameter so every platform is testable on any host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Mac,
    Windows,
    Linux,
}

impl Os {
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

/// How to tell whether a launch worked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wait {
    /// The program is the terminal itself: started means success.
    Spawn,
    /// The program is a launcher that exits at once (`open -a`): its exit code tells.
    Exit,
}

/// One way to open a terminal, tried in order until one starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub wait: Wait,
}

impl Candidate {
    fn spawn(program: impl Into<OsString>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            wait: Wait::Spawn,
        }
    }

    fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }

    /// `--flag=<dir>` as a single argument, for terminals that require it.
    fn joined_arg(self, flag: &str, dir: &Path) -> Self {
        let mut arg = OsString::from(flag);
        arg.push(dir.as_os_str());
        self.arg(arg)
    }
}

/// Whether `program` is Windows Terminal (`wt`, `wt.exe`, or a path to it).
fn is_windows_terminal(program: &str) -> bool {
    let name = program.rsplit(['\\', '/']).next().unwrap_or(program);
    name.eq_ignore_ascii_case("wt") || name.eq_ignore_ascii_case("wt.exe")
}

/// Windows Terminal splits its command line on `;` (new tab / pane), even inside quotes:
/// `C:\r\a;calc` would run `calc`. `\;` is its escape for a literal semicolon.
pub fn escape_wt_arg(arg: &str) -> String {
    arg.replace(';', "\\;")
}

/// `wt.exe -d <dir>` with the directory escaped for Windows Terminal.
fn windows_terminal(program: &str, dir: &Path) -> Candidate {
    Candidate::spawn(program)
        .arg("-d")
        .arg(escape_wt_arg(&dir.to_string_lossy()))
}

/// Quotes one argument for `CommandLineToArgvW` / the MSVC runtime: backslashes are
/// literal except before a quote, where they and the quote are escaped.
fn quote_windows_arg(arg: &str, out: &mut String) {
    let needs_quotes = arg.is_empty() || arg.contains([' ', '\t', '\n', '"']);
    if !needs_quotes {
        out.push_str(arg);
        return;
    }
    out.push('"');
    let mut backslashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    // Backslashes before the closing quote must not escape it.
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
}

/// Command line given to `CreateProcessW`. Paths are converted lossily: a path that is not
/// valid UTF-16 cannot be a repository Git handles anyway.
pub fn windows_command_line(candidate: &Candidate) -> String {
    let mut line = String::new();
    quote_windows_arg(&candidate.program.to_string_lossy(), &mut line);
    for arg in &candidate.args {
        line.push(' ');
        quote_windows_arg(&arg.to_string_lossy(), &mut line);
    }
    line
}

pub const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

/// Windows Terminal opens its own window; anything else (cmd, pwsh, a GUI terminal) gets a
/// new console, so a console program is not attached to yaggui's (or the dev server's) one.
/// The flag is ignored by GUI programs.
pub fn windows_creation_flags(candidate: &Candidate) -> u32 {
    if is_windows_terminal(&candidate.program.to_string_lossy()) {
        0
    } else {
        CREATE_NEW_CONSOLE
    }
}

/// Linux terminals tried after the preference, `$TERMINAL` and `x-terminal-emulator`,
/// with the flag that sets their working directory (the process cwd is also set).
fn linux_known(dir: &Path) -> Vec<Candidate> {
    vec![
        Candidate::spawn("gnome-terminal").joined_arg("--working-directory=", dir),
        Candidate::spawn("konsole").arg("--workdir").arg(dir),
        Candidate::spawn("xfce4-terminal").joined_arg("--working-directory=", dir),
        Candidate::spawn("kgx").joined_arg("--working-directory=", dir),
        Candidate::spawn("tilix").joined_arg("--working-directory=", dir),
        Candidate::spawn("alacritty")
            .arg("--working-directory")
            .arg(dir),
        Candidate::spawn("kitty").arg("--directory").arg(dir),
        Candidate::spawn("wezterm")
            .arg("start")
            .arg("--cwd")
            .arg(dir),
        Candidate::spawn("foot").joined_arg("--working-directory=", dir),
        Candidate::spawn("xterm"),
    ]
}

/// Ordered launch candidates for `dir`. `preference` is the configured terminal: an app
/// name on macOS (`iTerm`, `Warp`…), a program name or path elsewhere. `terminal_env` is
/// `$TERMINAL` (Linux only).
pub fn candidates(
    os: Os,
    dir: &Path,
    preference: Option<&str>,
    terminal_env: Option<OsString>,
) -> Vec<Candidate> {
    let preference = preference.map(str::trim).filter(|p| !p.is_empty());
    match os {
        Os::Mac => {
            let app = preference.unwrap_or("Terminal");
            vec![Candidate {
                wait: Wait::Exit,
                ..Candidate::spawn("open").arg("-a").arg(app).arg(dir)
            }]
        }
        // A configured terminal is used alone: silently opening another one would hide a typo.
        Os::Windows => match preference {
            // Without `-d`, Windows Terminal opens in the profile folder, not the repository.
            Some(program) if is_windows_terminal(program) => vec![windows_terminal(program, dir)],
            Some(program) => vec![Candidate::spawn(program)],
            None => vec![windows_terminal("wt.exe", dir), Candidate::spawn("cmd.exe")],
        },
        Os::Linux if preference.is_some() => preference.map(Candidate::spawn).into_iter().collect(),
        Os::Linux => {
            let mut list: Vec<Candidate> = terminal_env
                .filter(|t| !t.is_empty())
                .map(Candidate::spawn)
                .into_iter()
                .collect();
            list.push(Candidate::spawn("x-terminal-emulator"));
            list.extend(linux_known(dir));
            list
        }
    }
}

/// Starts a candidate in `dir`. `Ok(false)` means "not installed, try the next one".
#[cfg(windows)]
fn launch(candidate: &Candidate, dir: &Path) -> Result<bool, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, GetLastError,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, PROCESS_INFORMATION, STARTUPINFOW,
    };

    let mut command_line: Vec<u16> = windows_command_line(candidate)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let cwd: Vec<u16> = dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: plain C structs, valid when zeroed.
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = u32::try_from(std::mem::size_of::<STARTUPINFOW>()).unwrap_or(u32::MAX);
    // SAFETY: as above.
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: every pointer is valid for the call: the command line is a mutable,
    // NUL-terminated buffer (CreateProcessW may write to it), the cwd is NUL-terminated,
    // and the structs live on this stack frame. No handle is inherited.
    let created = unsafe {
        CreateProcessW(
            std::ptr::null(),
            command_line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            windows_creation_flags(candidate),
            std::ptr::null(),
            cwd.as_ptr(),
            &startup,
            &mut process,
        )
    };
    if created == 0 {
        // SAFETY: reads the calling thread's last error.
        let code = unsafe { GetLastError() };
        if code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND {
            return Ok(false);
        }
        return Err(format!(
            "{}: {}",
            windows_command_line(candidate),
            std::io::Error::from_raw_os_error(i32::try_from(code).unwrap_or(i32::MAX))
        ));
    }
    // SAFETY: both handles were just returned by CreateProcessW and are closed once.
    unsafe {
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    Ok(true)
}

/// Starts a candidate in `dir`. `Ok(false)` means "not installed, try the next one".
#[cfg(not(windows))]
fn launch(candidate: &Candidate, dir: &Path) -> Result<bool, String> {
    let mut command = Command::new(&candidate.program);
    crate::system::shell_env::apply(&mut command);
    command
        .args(&candidate.args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(match candidate.wait {
            Wait::Exit => Stdio::piped(),
            Wait::Spawn => Stdio::null(),
        });
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(format!("{}: {err}", candidate.program.to_string_lossy())),
    };
    match candidate.wait {
        Wait::Exit => {
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                // Only used for the error detail.
                let _ = pipe.read_to_string(&mut stderr);
            }
            let status = child.wait().map_err(|err| err.to_string())?;
            if status.success() {
                Ok(true)
            } else {
                Err(format!(
                    "{} {}: {status}\n{stderr}",
                    candidate.program.to_string_lossy(),
                    candidate
                        .args
                        .iter()
                        .map(|a| a.to_string_lossy())
                        .collect::<Vec<_>>()
                        .join(" "),
                ))
            }
        }
        Wait::Spawn => {
            // Reap the terminal when it exits so it does not linger as a zombie.
            let name = candidate.program.to_string_lossy().into_owned();
            let reaper = std::thread::Builder::new()
                .name("yaggui-terminal".into())
                .spawn(move || {
                    let _ = child.wait();
                });
            if let Err(err) = reaper {
                tracing::warn!(terminal = %name, error = %err, "cannot watch the terminal process");
            }
            Ok(true)
        }
    }
}

/// Opens a terminal in `dir`, trying each candidate in order. Returns the program used.
pub fn open_in(
    os: Os,
    dir: &Path,
    preference: Option<&str>,
    terminal_env: Option<OsString>,
) -> Result<String, YagguiError> {
    if !dir.is_dir() {
        return Err(YagguiError::repo_not_found(&dir.display().to_string()));
    }
    let preference = preference.map(str::trim).filter(|p| !p.is_empty());
    let list = candidates(os, dir, preference, terminal_env);
    let mut tried = Vec::new();
    for candidate in &list {
        let name = candidate.program.to_string_lossy().into_owned();
        match launch(candidate, dir) {
            Ok(true) => {
                tracing::info!(terminal = %name, dir = %dir.display(), "terminal opened");
                return Ok(name);
            }
            Ok(false) => tried.push(name),
            Err(detail) => {
                return Err(YagguiError::terminal_not_found(preference).with_detail(detail));
            }
        }
    }
    Err(YagguiError::terminal_not_found(preference)
        .with_detail(format!("not found in PATH: {}", tried.join(", "))))
}

/// `$TERMINAL` on Linux, ignored elsewhere.
pub fn terminal_env() -> Option<OsString> {
    std::env::var_os("TERMINAL")
}

/// Same as [`open_in`] for the current OS.
pub fn open(dir: &Path, preference: Option<&str>) -> Result<String, YagguiError> {
    open_in(Os::current(), dir, preference, terminal_env())
}

/// Validates a terminal preference before it is stored.
pub fn validate_preference(value: Option<&str>) -> Result<Option<String>, YagguiError> {
    let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if value.len() > 512 || value.contains('\0') {
        return Err(YagguiError::invalid_argument(
            "The terminal must be a program or application name.",
            "Le terminal doit être un nom de programme ou d'application.",
        ));
    }
    Ok(Some(value.to_owned()))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    /// Resolution never touches the disk: any path works.
    fn dir() -> PathBuf {
        PathBuf::from("/work/my repo")
    }

    fn programs(list: &[Candidate]) -> Vec<String> {
        list.iter()
            .map(|c| c.program.to_string_lossy().into_owned())
            .collect()
    }

    fn args(candidate: &Candidate) -> Vec<String> {
        candidate
            .args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn mac_uses_open_with_terminal_or_the_preference() {
        let list = candidates(Os::Mac, &dir(), None, None);
        assert_eq!(programs(&list), ["open"]);
        assert_eq!(args(&list[0]), ["-a", "Terminal", "/work/my repo"]);
        assert_eq!(list[0].wait, Wait::Exit);

        let list = candidates(Os::Mac, &dir(), Some(" iTerm "), None);
        assert_eq!(args(&list[0]), ["-a", "iTerm", "/work/my repo"]);
    }

    #[test]
    fn windows_prefers_windows_terminal_then_cmd() {
        let list = candidates(Os::Windows, &dir(), None, None);
        assert_eq!(programs(&list), ["wt.exe", "cmd.exe"]);
        assert_eq!(args(&list[0]), ["-d", "/work/my repo"]);
        assert_eq!(windows_creation_flags(&list[0]), 0);
        assert_eq!(windows_creation_flags(&list[1]), CREATE_NEW_CONSOLE);
        assert_eq!(windows_command_line(&list[1]), "cmd.exe");
    }

    #[test]
    fn windows_terminal_semicolons_are_escaped() {
        let repo = PathBuf::from(r"C:\r\a;calc");
        let list = candidates(Os::Windows, &repo, None, None);
        assert_eq!(args(&list[0]), ["-d", r"C:\r\a\;calc"]);
        assert_eq!(windows_command_line(&list[0]), r"wt.exe -d C:\r\a\;calc");
        // `;;` and a trailing `;` stay literal too.
        assert_eq!(escape_wt_arg("a;;b;"), r"a\;\;b\;");
    }

    #[test]
    fn a_windows_terminal_preference_gets_the_directory() {
        for program in [
            "wt",
            "WT.EXE",
            r"C:\Users\me\AppData\Local\Microsoft\WindowsApps\wt.exe",
        ] {
            let list = candidates(Os::Windows, Path::new(r"C:\my repo;x"), Some(program), None);
            assert_eq!(args(&list[0]), ["-d", r"C:\my repo\;x"], "{program}");
            assert_eq!(windows_creation_flags(&list[0]), 0);
        }
        // Console programs get their own console and no arguments.
        let list = candidates(Os::Windows, &dir(), Some("pwsh"), None);
        assert!(list[0].args.is_empty());
        assert_eq!(windows_creation_flags(&list[0]), CREATE_NEW_CONSOLE);
    }

    #[test]
    fn windows_command_line_quotes_like_the_msvc_runtime() {
        let quoted =
            |program: &str, arg: &str| windows_command_line(&Candidate::spawn(program).arg(arg));
        assert_eq!(quoted("wt.exe", r"C:\my repo\"), r#"wt.exe "C:\my repo\\""#);
        assert_eq!(quoted("wt.exe", r#"a"b"#), r#"wt.exe "a\"b""#);
        assert_eq!(quoted("wt.exe", r#"a\"b"#), r#"wt.exe "a\\\"b""#);
        assert_eq!(quoted("wt.exe", ""), r#"wt.exe """#);
        assert_eq!(
            quoted(r"C:\Program Files\x.exe", "C:\\plain"),
            r#""C:\Program Files\x.exe" C:\plain"#
        );
        // `&`, `|`, `%` have no meaning outside cmd.exe: kept as is, no shell is involved.
        assert_eq!(quoted("wt.exe", "a&b|c%d%"), "wt.exe a&b|c%d%");
    }

    #[test]
    fn linux_tries_env_then_debian_alternative_then_known_terminals() {
        let list = candidates(Os::Linux, &dir(), None, Some("foot".into()));
        let names = programs(&list);
        assert_eq!(
            &names[..3],
            ["foot", "x-terminal-emulator", "gnome-terminal"]
        );
        assert!(names.contains(&"konsole".to_owned()));
        assert_eq!(names.last().map(String::as_str), Some("xterm"));
        assert_eq!(args(&list[2]), ["--working-directory=/work/my repo"]);

        let list = candidates(Os::Linux, &dir(), None, Some("".into()));
        assert_eq!(programs(&list)[0], "x-terminal-emulator");
    }

    #[test]
    fn a_preference_is_used_alone_on_windows_and_linux() {
        for os in [Os::Windows, Os::Linux] {
            let list = candidates(os, &dir(), Some("alacritty"), Some("foot".into()));
            assert_eq!(programs(&list), ["alacritty"]);
            assert!(list[0].args.is_empty());
        }
        // A blank preference means "default".
        let list = candidates(Os::Windows, &dir(), Some("  "), None);
        assert_eq!(programs(&list), ["wt.exe", "cmd.exe"]);
    }

    #[test]
    fn the_directory_is_a_single_argument_even_with_shell_characters() {
        let tricky = PathBuf::from("/tmp/a b; rm -rf ~ $(x)");
        let list = candidates(Os::Mac, &tricky, None, None);
        assert_eq!(args(&list[0])[2], "/tmp/a b; rm -rf ~ $(x)");
    }

    #[test]
    fn missing_terminal_is_a_typed_error() {
        let repo = tempfile::tempdir().expect("temp dir");
        let err = open_in(
            Os::Linux,
            repo.path(),
            Some("yaggui-no-such-terminal"),
            None,
        )
        .expect_err("no such terminal");
        assert_eq!(err.code, crate::git::errors::ErrorCode::TerminalNotFound);
        assert_eq!(
            err.action,
            Some(crate::git::errors::ErrorAction::ConfigureTerminal)
        );
        assert!(err.message.en.contains("yaggui-no-such-terminal"));
        assert!(
            err.detail
                .unwrap_or_default()
                .contains("yaggui-no-such-terminal")
        );
    }

    #[test]
    fn missing_directory_is_reported() {
        let err = open_in(Os::Linux, Path::new("/no/such/yaggui/dir"), None, None)
            .expect_err("missing dir");
        assert_eq!(err.code, crate::git::errors::ErrorCode::RepoNotFound);
    }

    #[cfg(unix)]
    #[test]
    fn launches_the_first_available_terminal_in_the_directory() {
        use std::os::unix::fs::PermissionsExt;
        let repo = tempfile::tempdir().expect("temp dir");
        let bin = tempfile::tempdir().expect("bin dir");
        let marker = repo.path().join("launched");
        let script = bin.path().join("fake-term");
        // Written aside then renamed: `> launched` alone creates the file before `pwd` fills
        // it, and a loaded machine let the test read it empty.
        std::fs::write(
            &script,
            "#!/bin/sh\npwd > launched.part && mv launched.part launched\n",
        )
        .expect("write script");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        // Another test forking while the script was open for writing makes its child hold
        // the descriptor until it execs: running the script then fails with ETXTBSY ("Text
        // file busy"). Only the test writes an executable, so it retries.
        let launch = || {
            open_in(
                Os::Linux,
                repo.path(),
                Some(script.to_str().expect("utf-8 path")),
                None,
            )
        };
        let mut result = launch();
        for _ in 0..100 {
            match &result {
                Err(err)
                    if err
                        .detail
                        .as_deref()
                        .is_some_and(|d| d.contains("os error 26")) =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    result = launch();
                }
                _ => break,
            }
        }
        let used = result.expect("terminal launched");
        assert!(used.ends_with("fake-term"));
        // The terminal is detached: give a loaded machine time to start it.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while !marker.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let cwd = std::fs::read_to_string(&marker).expect("script ran");
        assert_eq!(
            std::fs::canonicalize(cwd.trim()).expect("cwd"),
            std::fs::canonicalize(repo.path()).expect("repo")
        );
    }

    #[test]
    fn validates_preferences() {
        assert_eq!(validate_preference(Some("  ")).ok(), Some(None));
        assert_eq!(
            validate_preference(Some(" kitty ")).ok(),
            Some(Some("kitty".to_owned()))
        );
        assert!(validate_preference(Some("a\0b")).is_err());
    }
}
