//! `ssh` started by git must not reach the terminal yaggui was started from: with a controlling
//! terminal, it would ask for a key passphrase on `/dev/tty` and wait there until cancelled.
//! Own test binary: the test re-runs itself in a process that owns a new pseudo-terminal.
#![cfg(unix)]

mod common;

use std::fs::OpenOptions;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::errors::ErrorCode;
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::ops::types::FetchTarget;
use yaggui_lib::repo::RepoManager;
use yaggui_lib::store::Store;

const CHILD_ENV: &str = "YAGGUI_TEST_IN_TERMINAL";
const AGENT_SOCK: &str = "/tmp/yaggui-test-agent.sock";

/// Stands in for ssh: prompts on the terminal when it has one (like a passphrase prompt that
/// nobody answers), then fails like an ssh without a usable key. Records what it saw.
const FAKE_SSH: &str = r#"#!/bin/sh
printf '%s' "$SSH_AUTH_SOCK" > "$YAGGUI_TEST_DIR/agent"
if (: </dev/tty) 2>/dev/null; then
  echo tty > "$YAGGUI_TEST_DIR/tty"
  sleep 5
fi
echo "git@example.invalid: Permission denied (publickey)." >&2
exit 255
"#;

#[test]
fn ssh_started_by_git_has_no_controlling_terminal() {
    if std::env::var_os(CHILD_ENV).is_some() {
        fetch_from_a_terminal();
        return;
    }
    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    // SAFETY: valid out-pointers; null name, termios and window size are allowed.
    let opened = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    assert_eq!(opened, 0, "openpty: {}", std::io::Error::last_os_error());

    let mut child = Command::new(std::env::current_exe().unwrap());
    child
        .args([
            "--exact",
            "ssh_started_by_git_has_no_controlling_terminal",
            "--nocapture",
        ])
        .env(CHILD_ENV, "1")
        .env("SSH_AUTH_SOCK", AGENT_SOCK)
        .stdin(Stdio::null());
    // SAFETY: `setsid` and `ioctl` are async-signal-safe. The pseudo-terminal becomes the
    // controlling terminal of the re-run test, like a terminal yaggui is launched from.
    unsafe {
        child.pre_exec(move || {
            if libc::setsid() == -1 || libc::ioctl(slave, libc::TIOCSCTTY as _, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let output = child.output().unwrap();
    // SAFETY: both descriptors come from `openpty` and are closed once.
    unsafe {
        libc::close(slave);
        libc::close(master);
    }
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn fetch_from_a_terminal() {
    // Otherwise this test would prove nothing.
    OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .expect("the re-run test has a controlling terminal");

    let fx = common::Fixture::new("clean");
    fx.git(&[
        "remote",
        "add",
        "secure",
        "ssh://git@example.invalid/team/repo.git",
    ]);
    let seen = tempfile::tempdir().unwrap();
    let ssh = seen.path().join("fake-ssh");
    std::fs::write(&ssh, FAKE_SSH).unwrap();
    std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();

    let sink = Arc::new(common::RecordingSink::default());
    let git = GitCli::new(Arc::new(CommandLog::new()), sink.clone())
        .with_env("GIT_CONFIG_NOSYSTEM", "1")
        .with_env("GIT_CONFIG_GLOBAL", "/dev/null")
        // Test only: yaggui itself never sets the ssh command.
        .with_env("GIT_SSH", &ssh)
        .with_env("GIT_SSH_VARIANT", "simple")
        .with_env("YAGGUI_TEST_DIR", seen.path());
    let store = Arc::new(Store::open_in_memory().unwrap());
    let repos = RepoManager::new(Arc::new(git), store, sink).without_watcher();
    let id = repos.open(&fx.repo_str()).unwrap().id;

    let start = Instant::now();
    let error = repos
        .fetch(
            id,
            FetchTarget::Remote {
                name: "secure".into(),
            },
            false,
        )
        .expect_err("ssh fails without a key");
    let elapsed = start.elapsed();

    assert!(
        !seen.path().join("tty").exists(),
        "ssh could open the terminal"
    );
    assert_eq!(error.code, ErrorCode::AuthFailed, "{error:?}");
    assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
    // ssh-agent stays reachable.
    assert_eq!(
        std::fs::read_to_string(seen.path().join("agent")).unwrap(),
        AGENT_SOCK
    );
}
