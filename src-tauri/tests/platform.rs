//! Windows-oriented behaviour that can be simulated on any OS: line endings
//! (`core.autocrlf`), no executable bit (`core.fileMode=false`), long paths, and the
//! `index.lock` left by a command killed on cancellation.
// The fake git below is a shell script.
#![cfg(unix)]

mod common;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use common::{Fixture, RecordingSink};
use yaggui_lib::git::cli::{CancelToken, GitCli, GitCommand};
use yaggui_lib::git::errors::ErrorCode;
use yaggui_lib::git::log::CommandLog;

/// A `git` that takes the lock, ignores SIGTERM and hangs: what a Windows kill looks like
/// (`TerminateJobObject` gives git no chance to clean up).
fn stubborn_git(dir: &Path, takes_lock: bool) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join("fake-git");
    let lock = if takes_lock {
        ": > .git/index.lock\n"
    } else {
        ""
    };
    std::fs::write(
        &script,
        format!("#!/bin/sh\ntrap '' TERM\n{lock}: > started\nwhile :; do sleep 1; done\n"),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script
}

#[test]
fn a_killed_command_does_not_leave_its_index_lock() {
    let fx = Fixture::new("clean");
    let tools = tempfile::tempdir().unwrap();
    let sink = Arc::new(RecordingSink::default());
    let git = GitCli::with_binary(
        stubborn_git(tools.path(), true),
        Arc::new(CommandLog::new()),
        sink,
    );
    let lock = fx.repo().join(".git/index.lock");
    let cancel = CancelToken::new();
    let canceller = {
        let cancel = cancel.clone();
        let lock = lock.clone();
        std::thread::spawn(move || {
            while !lock.exists() {
                std::thread::sleep(Duration::from_millis(10));
            }
            cancel.cancel();
        })
    };
    let command = GitCommand::new(["commit"]).cwd(fx.repo()).index_lock(&lock);
    let err = git.run_with(&command, Some(&cancel), None).unwrap_err();
    canceller.join().unwrap();
    assert_eq!(err.code, ErrorCode::Cancelled);
    assert!(!lock.exists(), "index.lock left behind");
    let entry = git.log().entries().pop().unwrap();
    assert!(entry.stderr.contains("removed the index.lock"));
}

/// A lock that predates the command is another process's: never removed.
#[test]
fn a_lock_older_than_the_command_is_kept() {
    let fx = Fixture::new("clean");
    let lock = fx.repo().join(".git/index.lock");
    std::fs::write(&lock, "").unwrap();
    let old = std::process::Command::new("touch")
        .args(["-m", "-d", "@1700000000"])
        .arg(&lock)
        .status()
        .unwrap();
    assert!(old.success());
    let tools = tempfile::tempdir().unwrap();
    let sink = Arc::new(RecordingSink::default());
    let git = GitCli::with_binary(
        stubborn_git(tools.path(), false),
        Arc::new(CommandLog::new()),
        sink,
    );
    let cancel = CancelToken::new();
    let canceller = {
        let cancel = cancel.clone();
        let started = fx.repo().join("started");
        std::thread::spawn(move || {
            while !started.exists() {
                std::thread::sleep(Duration::from_millis(10));
            }
            cancel.cancel();
        })
    };
    let command = GitCommand::new(["commit"]).cwd(fx.repo()).index_lock(&lock);
    let err = git.run_with(&command, Some(&cancel), None).unwrap_err();
    canceller.join().unwrap();
    assert_eq!(err.code, ErrorCode::Cancelled);
    assert!(lock.exists());
}
