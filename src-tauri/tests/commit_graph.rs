//! Background commit-graph write when a repository is opened without one.

mod common;

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;

use common::{Backend, Fixture, backend};
use yaggui_lib::events::{BackendEvent, OpKind, OpOutcome};
use yaggui_lib::git::ops::commit_graph::MIN_MISSING_COMMITS;

/// Appends `count` linear commits on `main` with `git fast-import` (no commit-graph).
fn add_commits(fx: &Fixture, count: usize) {
    let mut stream = String::new();
    for i in 0..count {
        let mark = i + 1;
        stream.push_str(&format!(
            "commit refs/heads/main\nmark :{mark}\ncommitter yaggui Tests <tests@yaggui.dev> {} +0000\ndata <<EOF\ncommit {i}\nEOF\n",
            1_600_000_000 + i
        ));
        if i == 0 {
            stream.push_str("from refs/heads/main^0\n");
        }
        stream.push_str(&format!(
            "M 644 inline file-{}.txt\ndata <<EOF\n{i}\nEOF\n\n",
            i % 7
        ));
    }
    let mut child = Command::new("git")
        .args(["fast-import", "--quiet"])
        .current_dir(fx.repo())
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stream.as_bytes())
        .unwrap();
    assert!(child.wait().unwrap().success());
}

fn graph_file(fx: &Fixture) -> std::path::PathBuf {
    fx.repo().join(".git/objects/info/commit-graph")
}

fn commit_graph_ops(b: &Backend) -> Vec<OpOutcome> {
    b.sink
        .events()
        .into_iter()
        .filter_map(|e| match e {
            BackendEvent::OpFinished(f) if f.kind == OpKind::CommitGraph => Some(f.outcome),
            _ => None,
        })
        .collect()
}

#[test]
fn writes_a_missing_commit_graph_in_the_background_then_rebuilds_the_graph() {
    let fx = Fixture::new("clean");
    add_commits(&fx, MIN_MISSING_COMMITS + 200);
    assert!(!graph_file(&fx).exists());
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;

    // The first page is served from the objects, the write comes after.
    let before = b.repos.graph_page(id, 0, 500).unwrap();
    assert!(before.total_rows as usize > MIN_MISSING_COMMITS);
    assert!(b.sink.wait_for(Duration::from_secs(30), |e| matches!(
        e,
        BackendEvent::OpFinished(f) if f.kind == OpKind::CommitGraph
    )));
    assert!(matches!(
        commit_graph_ops(&b)[..],
        [OpOutcome::Success { .. }]
    ));
    assert!(graph_file(&fx).exists());
    let logged = b.git.log().entries();
    assert!(logged.iter().any(|entry| entry.args.starts_with(&[
        "commit-graph".to_owned(),
        "write".to_owned(),
        "--reachable".to_owned(),
        "--changed-paths".to_owned(),
    ])));

    // Same rows, new version (read from the file now), and no second write.
    let after = b.repos.graph_page(id, 0, 500).unwrap();
    assert_ne!(after.version, before.version);
    assert_eq!(after.total_rows, before.total_rows);
    assert_eq!(after.shas, before.shas);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(commit_graph_ops(&b).len(), 1);
}

#[test]
fn small_or_covered_repositories_are_left_alone() {
    let fx = Fixture::new("clean");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    b.repos.graph_page(id, 0, 500).unwrap();

    let big = Fixture::new("clean");
    add_commits(&big, MIN_MISSING_COMMITS + 200);
    big.git(&["config", "core.commitGraph", "false"]);
    let id = b.repos.open(&big.repo_str()).unwrap().id;
    b.repos.graph_page(id, 0, 500).unwrap();

    std::thread::sleep(Duration::from_millis(300));
    assert!(commit_graph_ops(&b).is_empty());
    assert!(!graph_file(&fx).exists());
    assert!(!graph_file(&big).exists());
}

#[test]
fn a_cancelled_write_leaves_no_lock_behind() {
    use yaggui_lib::git::cli::CancelToken;
    use yaggui_lib::git::ops::commit_graph;

    let fx = Fixture::new("clean");
    add_commits(&fx, 60_000);
    let b = backend(false);
    let objects = fx.repo().join(".git/objects");
    let lock = objects.join("info/commit-graph.lock");
    let cancel = CancelToken::new();
    let watcher = {
        let cancel = cancel.clone();
        let lock = lock.clone();
        std::thread::spawn(move || {
            let started = std::time::Instant::now();
            while started.elapsed() < Duration::from_secs(30) {
                if lock.exists() {
                    cancel.cancel();
                    return true;
                }
                std::thread::sleep(Duration::from_micros(200));
            }
            false
        })
    };
    let result = commit_graph::write(&b.git, &fx.repo(), &objects, 1, &cancel);
    let cancelled_while_locked = watcher.join().unwrap();
    if result.is_ok() {
        // The write won the race: nothing to clean up, and nothing left either.
        assert!(!lock.exists());
        return;
    }
    assert!(cancelled_while_locked);
    assert!(!lock.exists(), "commit-graph.lock left behind");
    // Git can write the file again (it fails while a lock exists).
    commit_graph::write(&b.git, &fx.repo(), &objects, 1, &CancelToken::new()).unwrap();
    assert!(graph_file(&fx).exists());
}
