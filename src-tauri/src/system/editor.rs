//! Opens a file or folder in the user's external editor (F-323).
//!
//! Not a Git command, so it does not go through `git/cli.rs`; as for the terminal, the program
//! and its argument are passed separately, never through a shell.

use std::ffi::OsString;
use std::path::Path;
use std::process::{Command, Stdio};

use super::terminal::Os;
use crate::git::errors::YagguiError;

/// The command that opens `target`: `preference` is an application name on macOS (`open -a`),
/// a program name or path elsewhere. Without a preference, the system's default application.
pub fn command(os: Os, target: &Path, preference: Option<&str>) -> (OsString, Vec<OsString>) {
    let preference = preference.map(str::trim).filter(|p| !p.is_empty());
    let target = target.as_os_str().to_owned();
    match (os, preference) {
        (Os::Mac, Some(app)) => ("open".into(), vec!["-a".into(), app.into(), target]),
        (Os::Mac, None) => ("open".into(), vec![target]),
        (Os::Windows, None) => ("explorer.exe".into(), vec![target]),
        (Os::Linux, None) => ("xdg-open".into(), vec![target]),
        (_, Some(program)) => (program.into(), vec![target]),
    }
}

/// Starts the editor on `target` without waiting for it. Returns the program that was started.
pub fn open(target: &Path, preference: Option<&str>) -> Result<String, YagguiError> {
    open_with(Os::current(), target, preference)
}

fn open_with(os: Os, target: &Path, preference: Option<&str>) -> Result<String, YagguiError> {
    let preference = preference.map(str::trim).filter(|p| !p.is_empty());
    let (program, args) = command(os, target, preference);
    let name = program.to_string_lossy().into_owned();
    let mut child = Command::new(&program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                YagguiError::editor_not_found(preference)
            } else {
                YagguiError::editor_not_found(preference).with_detail(format!("{name}: {err}"))
            }
        })?;
    tracing::info!(editor = %name, target = %target.display(), "editor opened");
    // Reap the editor when it exits so it does not linger as a zombie.
    let reaper = std::thread::Builder::new()
        .name("yaggui-editor".into())
        .spawn(move || {
            let _ = child.wait();
        });
    if let Err(err) = reaper {
        tracing::warn!(editor = %name, error = %err, "cannot watch the editor process");
    }
    Ok(program.to_string_lossy().into_owned())
}

/// The command that shows `target` in the system file manager (F-087): selected in Finder
/// or Explorer, its folder opened elsewhere (no common way to select a file on Linux).
pub fn reveal_command(os: Os, target: &Path) -> (OsString, Vec<OsString>) {
    match os {
        Os::Mac => (
            "open".into(),
            vec!["-R".into(), target.as_os_str().to_owned()],
        ),
        Os::Windows => {
            let mut select = OsString::from("/select,");
            select.push(target.as_os_str());
            ("explorer.exe".into(), vec![select])
        }
        Os::Linux => {
            let folder = if target.is_dir() {
                target
            } else {
                target.parent().unwrap_or(target)
            };
            ("xdg-open".into(), vec![folder.as_os_str().to_owned()])
        }
    }
}

/// Shows `target` in the file manager without waiting for it.
pub fn reveal(target: &Path) -> Result<(), YagguiError> {
    let (program, args) = reveal_command(Os::current(), target);
    let name = program.to_string_lossy().into_owned();
    let mut command = Command::new(&program);
    #[cfg(windows)]
    {
        // Explorer parses `/select,"path"` itself and does not follow the usual quoting:
        // the argument goes as is (a Windows path cannot contain `"`).
        use std::os::windows::process::CommandExt;
        let _ = &args;
        command.raw_arg(format!("/select,\"{}\"", target.display()));
    }
    #[cfg(not(windows))]
    command.args(&args);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| YagguiError::editor_not_found(None).with_detail(format!("{name}: {err}")))?;
    let reaper = std::thread::Builder::new()
        .name("yaggui-reveal".into())
        .spawn(move || {
            let _ = child.wait();
        });
    if let Err(err) = reaper {
        tracing::warn!(program = %name, error = %err, "cannot watch the file manager process");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn mac_uses_open_with_the_application() {
        let (program, args) = command(Os::Mac, Path::new("/r/a b.txt"), Some(" Zed "));
        assert_eq!(program, "open");
        assert_eq!(strings(&args), ["-a", "Zed", "/r/a b.txt"]);
        let (_, args) = command(Os::Mac, Path::new("/r"), None);
        assert_eq!(strings(&args), ["/r"]);
    }

    #[test]
    fn elsewhere_runs_the_program_or_the_system_opener() {
        let (program, args) = command(Os::Linux, Path::new("/r; rm -rf ~"), Some("code"));
        assert_eq!(program, "code");
        assert_eq!(strings(&args), ["/r; rm -rf ~"]);
        assert_eq!(command(Os::Linux, Path::new("/r"), None).0, "xdg-open");
        assert_eq!(
            command(Os::Windows, Path::new("C:\\r"), None).0,
            "explorer.exe"
        );
        assert_eq!(
            command(Os::Windows, Path::new("C:\\r"), Some("  ")).0,
            "explorer.exe"
        );
    }

    #[test]
    fn reveals_in_the_file_manager() {
        let (program, args) = reveal_command(Os::Mac, Path::new("/r/a b.png"));
        assert_eq!(program, "open");
        assert_eq!(strings(&args), ["-R", "/r/a b.png"]);
        let (program, args) = reveal_command(Os::Windows, Path::new("C:\\r\\a.png"));
        assert_eq!(program, "explorer.exe");
        assert_eq!(strings(&args), ["/select,C:\\r\\a.png"]);
        let (program, args) = reveal_command(Os::Linux, Path::new("/no-such-dir/a.png"));
        assert_eq!(program, "xdg-open");
        assert_eq!(strings(&args), ["/no-such-dir"]);
    }

    #[test]
    fn a_missing_editor_is_a_typed_error() {
        let err = open_with(Os::Linux, Path::new("/"), Some("yaggui-no-such-editor")).unwrap_err();
        assert_eq!(err.code, crate::git::errors::ErrorCode::EditorNotFound);
    }
}
