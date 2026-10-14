//! Integrated terminal (F-267): a real shell in a PTY, through `PtyManager`.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::RecordingSink;
use yaggui_lib::events::BackendEvent;
use yaggui_lib::system::pty::PtyManager;

const TIMEOUT: Duration = Duration::from_secs(20);

/// Everything the terminal `pty_id` printed so far.
fn output(sink: &RecordingSink, pty_id: u32) -> String {
    sink.events()
        .into_iter()
        .filter_map(|event| match event {
            BackendEvent::PtyOutput(o) if o.pty_id == pty_id => Some(o.data),
            _ => None,
        })
        .collect()
}

fn exited(sink: &RecordingSink, pty_id: u32) -> Option<Option<u32>> {
    sink.events().into_iter().find_map(|event| match event {
        BackendEvent::PtyExited(e) if e.pty_id == pty_id => Some(e.exit_code),
        _ => None,
    })
}

fn wait_output(sink: &RecordingSink, pty_id: u32, needle: &str) {
    let found = sink.wait_for(TIMEOUT, |_| output(sink, pty_id).contains(needle));
    assert!(
        found,
        "{needle:?} not printed; output so far:\n{}",
        output(sink, pty_id)
    );
}

/// ConPTY asks for the cursor position (`ESC[6n`) when it starts and waits for the reply
/// before running the shell; in the app, xterm.js answers it.
fn answer_cursor_query(manager: &PtyManager, sink: &RecordingSink, pty_id: u32) {
    if cfg!(windows) {
        wait_output(sink, pty_id, "\x1b[6n");
        manager.write(pty_id, "\x1b[1;1R").expect("write");
    }
}

#[test]
fn runs_a_shell_in_the_folder_resizes_and_closes() {
    let dir = tempfile::tempdir().expect("temp dir");
    let cwd = yaggui_lib::system::paths::canonical(dir.path());
    let sink = Arc::new(RecordingSink::default());
    let manager = PtyManager::new(sink.clone());

    let info = manager.spawn(7, &cwd, 80, 24).expect("shell started");
    assert!(!info.shell.is_empty());
    assert_eq!(manager.count(7), 1);
    answer_cursor_query(&manager, &sink, info.pty_id);

    // The echo of the typed line shows `he''llo`: only the command output reads `hello`.
    manager.write(info.pty_id, "echo he''llo\r").expect("write");
    wait_output(&sink, info.pty_id, "hello");

    #[cfg(unix)]
    {
        manager.write(info.pty_id, "pwd\r").expect("write");
        wait_output(&sink, info.pty_id, &cwd.display().to_string());

        manager.resize(info.pty_id, 100, 30).expect("resize");
        manager.write(info.pty_id, "stty size\r").expect("write");
        wait_output(&sink, info.pty_id, "30 100");
    }
    #[cfg(windows)]
    manager.resize(info.pty_id, 100, 30).expect("resize");

    manager.close(info.pty_id);
    assert_eq!(manager.count(7), 0);
    assert!(
        sink.wait_for(TIMEOUT, |_| exited(&sink, info.pty_id).is_some()),
        "no pty-exited after close"
    );
    assert!(manager.write(info.pty_id, "ls\r").is_err());
}

#[test]
fn reports_the_exit_code_after_the_last_output() {
    let dir = tempfile::tempdir().expect("temp dir");
    let sink = Arc::new(RecordingSink::default());
    let manager = PtyManager::new(sink.clone());
    let info = manager.spawn(1, dir.path(), 80, 24).expect("shell started");
    answer_cursor_query(&manager, &sink, info.pty_id);

    manager
        .write(info.pty_id, "echo by''e; exit 3\r")
        .expect("write");
    assert!(
        sink.wait_for(TIMEOUT, |_| exited(&sink, info.pty_id).is_some()),
        "shell did not exit; output:\n{}",
        output(&sink, info.pty_id)
    );
    assert_eq!(exited(&sink, info.pty_id), Some(Some(3)));
    let events = sink.events();
    let last_output = events
        .iter()
        .rposition(|e| matches!(e, BackendEvent::PtyOutput(o) if o.pty_id == info.pty_id));
    let exit = events
        .iter()
        .position(|e| matches!(e, BackendEvent::PtyExited(x) if x.pty_id == info.pty_id));
    assert!(last_output < exit, "pty-exited must follow the output");
    assert!(output(&sink, info.pty_id).contains("bye"));
    // An exited shell leaves the list by itself.
    assert_eq!(manager.count(1), 0);
}

#[test]
fn closing_a_repository_ends_all_its_terminals_only() {
    let dir = tempfile::tempdir().expect("temp dir");
    let sink = Arc::new(RecordingSink::default());
    let manager = PtyManager::new(sink.clone());
    let a = manager.spawn(1, dir.path(), 80, 24).expect("first");
    let b = manager.spawn(1, dir.path(), 80, 24).expect("second");
    let other = manager.spawn(2, dir.path(), 80, 24).expect("other repo");
    assert_eq!(manager.count(1), 2);

    manager.close_repo(1);
    assert_eq!(manager.count(1), 0);
    assert_eq!(manager.count(2), 1);
    for id in [a.pty_id, b.pty_id] {
        assert!(
            sink.wait_for(TIMEOUT, |_| exited(&sink, id).is_some()),
            "terminal {id} still running"
        );
    }
    assert!(exited(&sink, other.pty_id).is_none());

    manager.close_all();
    assert_eq!(manager.count(2), 0);
    assert!(sink.wait_for(TIMEOUT, |_| exited(&sink, other.pty_id).is_some()));
}

#[test]
fn rejects_a_bad_size() {
    let dir = tempfile::tempdir().expect("temp dir");
    let manager = PtyManager::new(Arc::new(RecordingSink::default()));
    let err = manager.spawn(1, dir.path(), 0, 24).expect_err("bad size");
    assert_eq!(
        err.code,
        yaggui_lib::git::errors::ErrorCode::InvalidArgument
    );
}
