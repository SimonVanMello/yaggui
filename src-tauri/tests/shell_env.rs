//! Hooks see the `PATH` of the user's login shell, not the short one of an app launched from
//! the Dock (husky: "npx: command not found").
//! Own test binary: it changes process-wide environment variables and a process-wide cache.
#![cfg(unix)]

mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use yaggui_lib::git::cli::GitCommand;
use yaggui_lib::system::shell_env;

fn write_executable(path: &Path, body: &str) {
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn hooks_find_tools_on_the_login_shell_path() {
    let fx = common::Fixture::new("clean");
    let tools = tempfile::tempdir().unwrap();
    // Only on the login shell's PATH, like `npx` under nvm or Homebrew.
    write_executable(
        &tools.path().join("yaggui-hook-tool"),
        "#!/bin/sh\necho tool ran >&2\n",
    );
    // A fake login shell: prints a banner, then the environment between the markers.
    let shell = tools.path().join("fake-shell");
    write_executable(
        &shell,
        &format!(
            "#!/bin/sh\necho 'Welcome'\necho __YAGGUI_ENV_START__\necho \"PATH={}:/usr/bin:/bin\"\necho __YAGGUI_ENV_END__\n",
            tools.path().display()
        ),
    );
    // SAFETY: the only test of this binary, set before any thread reads the environment.
    unsafe { std::env::set_var("SHELL", &shell) };

    fx.git(&["config", "user.name", "yaggui Tests"]);
    fx.git(&["config", "user.email", "tests@yaggui.dev"]);
    let hook = fx.repo().join(".git/hooks/pre-commit");
    write_executable(&hook, "#!/bin/sh\nexec yaggui-hook-tool\n");
    std::fs::write(fx.repo().join("a.txt"), "a\n").unwrap();
    fx.git(&["add", "a.txt"]);

    let b = common::backend(false);
    let commit = GitCommand::new(["commit", "-m", "Add a"]).cwd(fx.repo());

    // Before the login PATH is read, the hook gets the process PATH and fails.
    assert!(
        b.git.run(&commit).is_err(),
        "the tool is not on the test PATH"
    );

    shell_env::resolve_in_background();
    let out = b.git.run(&commit).unwrap();
    assert!(
        out.stderr.contains("tool ran"),
        "hook output: {}",
        out.stderr
    );
    // yaggui's own entries are kept after the shell's.
    let path = shell_env::child_path().unwrap();
    let dirs: Vec<_> = std::env::split_paths(&path).collect();
    assert_eq!(dirs.first().map(|d| d.as_path()), Some(tools.path()));
}
