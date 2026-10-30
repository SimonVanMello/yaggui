//! Opens a file or folder in the user's external editor (F-323).
//!
//! Not a Git command, so it does not go through `git/cli.rs`; as for the terminal, the program
//! and its argument are passed separately, never through a shell.

use std::ffi::OsString;
use std::path::Path;
use std::process::{Child, Command, Stdio};

use super::terminal::Os;
use crate::git::errors::YagguiError;

/// The command that opens `target` in the editor: `preference` is an application name on
/// macOS (`open -a`), a program name or path elsewhere. Without a preference, the system's
/// text editor (`open -t`, Notepad, on Linux the default application of a text file), never
/// its generic opener: `open`, `explorer.exe` or `xdg-open` given a script or an executable
/// committed by a hostile repository would run it.
pub fn command(os: Os, target: &Path, preference: Option<&str>) -> (OsString, Vec<OsString>) {
    let preference = preference.map(str::trim).filter(|p| !p.is_empty());
    let target = target.as_os_str().to_owned();
    match (os, preference) {
        (Os::Mac, Some(app)) => ("open".into(), vec!["-a".into(), app.into(), target]),
        (Os::Mac, None) => ("open".into(), vec!["-t".into(), target]),
        (Os::Windows, None) => ("notepad.exe".into(), vec![target]),
        (Os::Linux, None) => ("xdg-open".into(), vec![target]),
        (_, Some(program)) => (program.into(), vec![target]),
    }
}

/// The command that opens the folder `dir` in the system file manager. A folder whose name
/// has an extension may be a bundle on macOS (`Foo.app`, `Foo.workflow`): `open` would run
/// it, so it is revealed in its parent instead.
pub fn folder_command(os: Os, dir: &Path) -> (OsString, Vec<OsString>) {
    let target = dir.as_os_str().to_owned();
    match os {
        Os::Mac if dir.extension().is_some() => ("open".into(), vec!["-R".into(), target]),
        Os::Mac => ("open".into(), vec![target]),
        Os::Windows => ("explorer.exe".into(), vec![target]),
        Os::Linux => ("xdg-open".into(), vec![target]),
    }
}

/// Bytes read to decide whether a file is text.
const TEXT_PROBE_BYTES: usize = 8 * 1024;

/// Whether the fallback editor may be given `target` on Linux: a regular file whose first
/// bytes hold no NUL (an executable, an archive or an image is refused), and not a desktop
/// entry, which some desktops launch instead of showing.
fn is_text_file(target: &Path) -> bool {
    if target
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("desktop"))
    {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(target) else {
        return false;
    };
    let mut probe = vec![0_u8; TEXT_PROBE_BYTES];
    let mut read = 0;
    while read < probe.len() {
        match std::io::Read::read(&mut file, &mut probe[read..]) {
            Ok(0) => break,
            Ok(n) => read += n,
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return false,
        }
    }
    !probe[..read].contains(&0)
}

/// Starts the editor on `target` without waiting for it. Returns the program that was started.
pub fn open(target: &Path, preference: Option<&str>) -> Result<String, YagguiError> {
    open_with(Os::current(), target, preference)
}

fn open_with(os: Os, target: &Path, preference: Option<&str>) -> Result<String, YagguiError> {
    let preference = preference.map(str::trim).filter(|p| !p.is_empty());
    if preference.is_none() {
        // The fallback is a text editor: a folder, or on Linux a file the desktop could run
        // rather than show, needs a configured editor.
        if target.is_dir() || (os == Os::Linux && !is_text_file(target)) {
            return Err(YagguiError::editor_not_configured());
        }
    }
    let (mut program, args) = command(os, target, preference);
    if os == Os::Windows
        && preference.is_none()
        && let Some(resolved) = super::terminal::windows_program(&program)
    {
        // Notepad from System32, never from a folder on the search path.
        program = resolved.into_os_string();
    }
    let name = program.to_string_lossy().into_owned();
    let mut command = Command::new(&program);
    // An editor set by name (`code`, `zed`) lives where the user's shell finds it.
    crate::system::shell_env::apply(&mut command);
    let mut child = command
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
    // `open` hands the file to the application and returns at once: its exit status is the
    // only sign that the application does not exist, since spawning `open` itself succeeds.
    if os == Os::Mac {
        let status = child.wait().map_err(|err| {
            YagguiError::editor_not_found(preference).with_detail(format!("{name}: {err}"))
        })?;
        if !status.success() {
            return Err(
                YagguiError::editor_not_found(preference).with_detail(format!("{name}: {status}"))
            );
        }
        tracing::info!(editor = %name, target = %target.display(), "editor opened");
        return Ok(name);
    }
    tracing::info!(editor = %name, target = %target.display(), "editor opened");
    reap(child, &name, "yaggui-editor");
    Ok(name)
}

/// Waits for `child` on a thread so it does not linger as a zombie once it exits.
pub(crate) fn reap(mut child: Child, program: &str, thread: &str) {
    let reaper = std::thread::Builder::new()
        .name(thread.into())
        .spawn(move || {
            let _ = child.wait();
        });
    if let Err(err) = reaper {
        tracing::warn!(program = %program, error = %err, "cannot watch the started process");
    }
}

/// Opens the folder `dir` itself in the system file manager (Finder, Explorer, the default
/// one on Linux), unlike `reveal`, which selects it in its parent; see [`folder_command`].
pub fn open_folder(dir: &Path) -> Result<(), YagguiError> {
    open_folder_with(Os::current(), dir)
}

fn open_folder_with(os: Os, dir: &Path) -> Result<(), YagguiError> {
    if !dir.is_dir() {
        return Err(YagguiError::file_manager_failed()
            .with_detail(format!("not a folder: {}", dir.display())));
    }
    let (program, args) = folder_command(os, dir);
    let name = program.to_string_lossy().into_owned();
    let failed = |detail: String| {
        YagguiError::file_manager_failed().with_detail(format!("{name}: {detail}"))
    };
    let mut command = Command::new(&program);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null());
    if os == Os::Mac {
        // `open` hands the folder to Finder and returns at once: its exit status is the only
        // report of a failure.
        let output = command
            .stderr(Stdio::piped())
            .output()
            .map_err(|err| failed(err.to_string()))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(failed(format!("{}\n{stderr}", output.status)));
        }
    } else {
        // Not waited for: Explorer exits with 1 even when it opened the folder, and xdg-open
        // may only return once the file manager is closed.
        let child = command
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| failed(err.to_string()))?;
        reap(child, &name, "yaggui-file-manager");
    }
    tracing::info!(program = %name, dir = %dir.display(), "folder opened in the file manager");
    Ok(())
}

/// The command that opens a web page of yaggui in the default browser. Only for `https://`
/// addresses written in yaggui: the generic opener runs whatever it is given.
pub fn url_command(os: Os, url: &str) -> (OsString, Vec<OsString>) {
    match os {
        Os::Mac => ("open".into(), vec![url.into()]),
        Os::Windows => ("explorer.exe".into(), vec![url.into()]),
        Os::Linux => ("xdg-open".into(), vec![url.into()]),
    }
}

/// Opens `url` (an `https://` page of yaggui) in the default browser without waiting for it.
pub fn open_url(url: &str) -> Result<(), YagguiError> {
    if !url.starts_with("https://") {
        return Err(YagguiError::internal(format!("not a web page: {url}")));
    }
    let os = Os::current();
    let (mut program, args) = url_command(os, url);
    if os == Os::Windows
        && let Some(resolved) = super::terminal::windows_program(&program)
    {
        program = resolved.into_os_string();
    }
    let name = program.to_string_lossy().into_owned();
    let child = Command::new(&program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| YagguiError::browser_failed().with_detail(format!("{name}: {err}")))?;
    reap(child, &name, "yaggui-browser");
    Ok(())
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
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| YagguiError::editor_not_found(None).with_detail(format!("{name}: {err}")))?;
    reap(child, &name, "yaggui-reveal");
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
    fn web_pages_open_in_the_browser_not_an_editor() {
        let url = "https://example.com/a?b=c";
        for (os, program) in [
            (Os::Mac, "open"),
            (Os::Windows, "explorer.exe"),
            (Os::Linux, "xdg-open"),
        ] {
            let (found, args) = url_command(os, url);
            assert_eq!(found, program);
            assert_eq!(strings(&args), [url]);
        }
        assert_eq!(
            open_url("file:///etc/passwd").map_err(|err| err.code),
            Err(crate::git::errors::ErrorCode::Internal)
        );
    }

    #[test]
    fn mac_uses_open_with_the_application() {
        let (program, args) = command(Os::Mac, Path::new("/r/a b.txt"), Some(" Zed "));
        assert_eq!(program, "open");
        assert_eq!(strings(&args), ["-a", "Zed", "/r/a b.txt"]);
        // Without a preference: the text editor, never `open <file>`, which runs a `.command`.
        let (_, args) = command(Os::Mac, Path::new("/r/x.command"), None);
        assert_eq!(strings(&args), ["-t", "/r/x.command"]);
    }

    #[test]
    fn elsewhere_runs_the_program_or_the_system_opener() {
        let (program, args) = command(Os::Linux, Path::new("/r; rm -rf ~"), Some("code"));
        assert_eq!(program, "code");
        assert_eq!(strings(&args), ["/r; rm -rf ~"]);
        assert_eq!(command(Os::Linux, Path::new("/r"), None).0, "xdg-open");
        // Explorer would run `x.bat`: Notepad shows it.
        let (program, args) = command(Os::Windows, Path::new("C:\\r\\x.bat"), None);
        assert_eq!(program, "notepad.exe");
        assert_eq!(strings(&args), ["C:\\r\\x.bat"]);
        assert_eq!(
            command(Os::Windows, Path::new("C:\\r"), Some("  ")).0,
            "notepad.exe"
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
    fn opens_a_folder_itself_with_the_system_file_manager() {
        let (program, args) = folder_command(Os::Mac, Path::new("/r/my repo"));
        assert_eq!(program, "open");
        assert_eq!(strings(&args), ["/r/my repo"]);
        let (program, args) = folder_command(Os::Windows, Path::new("C:\\r\\my repo"));
        assert_eq!(program, "explorer.exe");
        assert_eq!(strings(&args), ["C:\\r\\my repo"]);
        let (program, args) = folder_command(Os::Linux, Path::new("/r/my repo; ls"));
        assert_eq!(program, "xdg-open");
        assert_eq!(strings(&args), ["/r/my repo; ls"]);
    }

    #[test]
    fn a_folder_that_may_be_a_bundle_is_revealed_on_mac_not_opened() {
        // A clone of `Foo.app.git` with a committed `Contents/MacOS/Foo`: `open` would launch it.
        for bundle in ["/r/Foo.app", "/r/x.workflow", "/r/next.js"] {
            let (program, args) = folder_command(Os::Mac, Path::new(bundle));
            assert_eq!(program, "open");
            assert_eq!(strings(&args), ["-R", bundle], "{bundle}");
        }
        let (_, args) = folder_command(Os::Mac, Path::new("/r/.hidden"));
        assert_eq!(strings(&args), ["/r/.hidden"]);
    }

    #[test]
    fn without_an_editor_a_folder_is_a_typed_error_on_every_os() {
        let dir = tempfile::tempdir().unwrap();
        for os in [Os::Mac, Os::Windows, Os::Linux] {
            let err = open_with(os, dir.path(), None).unwrap_err();
            assert_eq!(err.code, crate::git::errors::ErrorCode::EditorNotFound);
            assert!(err.message.en.contains("No editor is configured"), "{os:?}");
        }
    }

    #[test]
    fn without_an_editor_linux_only_hands_text_files_to_the_desktop() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("tool");
        std::fs::write(&binary, b"\x7fELF\x02\x01\x01\0\0\0").unwrap();
        let text = dir.path().join("x.sh");
        std::fs::write(&text, "#!/bin/sh\necho hi\n").unwrap();
        let empty = dir.path().join("empty");
        std::fs::write(&empty, "").unwrap();
        let desktop = dir.path().join("evil.desktop");
        std::fs::write(&desktop, "[Desktop Entry]\nExec=rm -rf ~\n").unwrap();
        assert!(!is_text_file(&binary));
        assert!(is_text_file(&text));
        assert!(is_text_file(&empty));
        assert!(!is_text_file(&desktop));
        assert!(!is_text_file(dir.path()));
        assert!(!is_text_file(&dir.path().join("missing")));
        for refused in [&binary, &desktop] {
            let err = open_with(Os::Linux, refused, None).unwrap_err();
            assert_eq!(err.code, crate::git::errors::ErrorCode::EditorNotFound);
            assert!(err.message.en.contains("No editor is configured"));
        }
    }

    #[test]
    fn a_missing_folder_is_a_typed_error_on_every_os() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "a").unwrap();
        for os in [Os::Mac, Os::Windows, Os::Linux] {
            for target in [dir.path().join("gone"), file.clone()] {
                let err = open_folder_with(os, &target).unwrap_err();
                assert_eq!(err.code, crate::git::errors::ErrorCode::FileManagerFailed);
                assert!(err.detail.unwrap().contains("not a folder"));
            }
        }
    }

    #[test]
    fn a_missing_editor_is_a_typed_error() {
        let err = open_with(Os::Linux, Path::new("/"), Some("yaggui-no-such-editor")).unwrap_err();
        assert_eq!(err.code, crate::git::errors::ErrorCode::EditorNotFound);
    }
}
