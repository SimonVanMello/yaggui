//! Filesystem watcher → debounced `status-changed` / `refs-changed` events.

mod common;

use std::time::Duration;

use common::{Fixture, backend};
use yaggui_lib::events::BackendEvent;

const TIMEOUT: Duration = Duration::from_secs(5);

fn is_status(e: &BackendEvent) -> bool {
    matches!(e, BackendEvent::StatusChanged(_))
}

fn is_refs(e: &BackendEvent) -> bool {
    matches!(e, BackendEvent::RefsChanged(_))
}

/// Lets the watcher settle (initial events, debounce) before the test acts.
fn settle(b: &common::Backend) {
    std::thread::sleep(Duration::from_millis(400));
    b.sink.clear();
}

#[test]
fn worktree_edit_emits_status_changed() {
    let fx = Fixture::new("dirty");
    let b = backend(true);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    settle(&b);

    std::fs::write(fx.repo().join("src.txt"), "edited\n").unwrap();
    assert!(b.sink.wait_for(
        TIMEOUT,
        |e| matches!(e, BackendEvent::StatusChanged(s) if s.repo_id == id)
    ));
    assert!(!b.sink.events().iter().any(is_refs));
}

#[test]
fn burst_of_changes_is_debounced() {
    let fx = Fixture::new("clean");
    let b = backend(true);
    b.repos.open(&fx.repo_str()).unwrap();
    settle(&b);

    for n in 0..20 {
        std::fs::write(fx.repo().join(format!("file-{n}.txt")), "x").unwrap();
    }
    assert!(b.sink.wait_for(TIMEOUT, is_status));
    std::thread::sleep(Duration::from_millis(400));
    let count = b.sink.events().iter().filter(|e| is_status(e)).count();
    assert!(count <= 2, "expected debounced events, got {count}");
}

#[test]
fn ref_update_emits_refs_changed() {
    let fx = Fixture::new("clean");
    let b = backend(true);
    b.repos.open(&fx.repo_str()).unwrap();
    settle(&b);

    fx.git(&["branch", "topic"]);
    assert!(b.sink.wait_for(TIMEOUT, is_refs));
}

#[test]
fn checkout_emits_both_events() {
    let fx = Fixture::new("clean");
    let b = backend(true);
    b.repos.open(&fx.repo_str()).unwrap();
    settle(&b);

    fx.git(&["checkout", "-q", "-b", "topic"]);
    assert!(b.sink.wait_for(TIMEOUT, is_refs));
    assert!(b.sink.wait_for(TIMEOUT, is_status));
}

#[test]
fn ignored_files_and_git_internals_are_silent() {
    let fx = Fixture::new("dirty");
    let b = backend(true);
    b.repos.open(&fx.repo_str()).unwrap();
    settle(&b);

    std::fs::write(fx.repo().join("build/out.o"), "rebuilt").unwrap();
    std::fs::create_dir_all(fx.repo().join("build/deep/er")).unwrap();
    std::fs::write(fx.repo().join("build/deep/er/x.o"), "x").unwrap();
    std::fs::write(fx.repo().join(".git/objects/noise"), "x").unwrap();
    std::fs::write(fx.repo().join(".git/FETCH_HEAD"), "x").unwrap();
    std::thread::sleep(Duration::from_millis(800));
    assert!(
        b.sink.events().is_empty(),
        "unexpected {:?}",
        b.sink.events()
    );
}

#[test]
fn closing_stops_watching() {
    let fx = Fixture::new("clean");
    let b = backend(true);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    settle(&b);
    b.repos.close(id);
    std::fs::write(fx.repo().join("after-close.txt"), "x").unwrap();
    std::thread::sleep(Duration::from_millis(600));
    assert!(!b.sink.events().iter().any(is_status));
}

#[test]
fn tracked_file_matching_an_ignore_pattern_still_emits() {
    let fx = Fixture::new("dirty");
    fx.git(&["add", "-f", "build/out.o"]);
    fx.git(&["commit", "-q", "-m", "track a build file"]);
    let b = backend(true);
    b.repos.open(&fx.repo_str()).unwrap();
    settle(&b);

    std::fs::write(fx.repo().join("build/out.o"), "changed").unwrap();
    assert!(b.sink.wait_for(TIMEOUT, is_status));
}

#[test]
fn config_edit_emits_refs_changed_and_reloads() {
    let fx = Fixture::new("clean");
    let b = backend(true);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    settle(&b);

    fx.git(&["branch", "--unset-upstream"]);
    assert!(b.sink.wait_for(TIMEOUT, is_refs));
    assert_eq!(b.repos.state(id).unwrap().upstream, None);
}

#[test]
fn linked_worktree_sees_refs_updated_from_the_main_worktree() {
    let fx = Fixture::new("worktree");
    let b = backend(true);
    let id = b
        .repos
        .open(&fx.root.join("wt").to_string_lossy())
        .unwrap()
        .id;
    settle(&b);

    // `topic` is created in the common dir, outside the linked worktree's own git dir.
    fx.git(&["branch", "topic"]);
    assert!(b.sink.wait_for(
        TIMEOUT,
        |e| matches!(e, BackendEvent::RefsChanged(r) if r.repo_id == id)
    ));

    // Its own HEAD and index live in `<common dir>/worktrees/wt`: still watched.
    settle(&b);
    fx.git_in(&fx.root.join("wt"), &["checkout", "-q", "--detach"]);
    assert!(b.sink.wait_for(
        TIMEOUT,
        |e| matches!(e, BackendEvent::RefsChanged(r) if r.repo_id == id)
    ));
}

#[test]
#[cfg(target_os = "linux")]
fn ignored_folders_and_git_internals_are_not_watched() {
    let fx = Fixture::new("dirty"); // ignores `build/`
    let repo = fx.repo();
    for dir in ["build/a/b", "build/c", "src/deep/er"] {
        std::fs::create_dir_all(repo.join(dir)).unwrap();
    }
    // Ignored by pattern but holding a tracked file: still watched.
    std::fs::create_dir_all(repo.join("vendor")).unwrap();
    std::fs::write(repo.join("vendor/lib.txt"), "lib\n").unwrap();
    fx.git(&["add", "vendor/lib.txt"]);
    std::fs::write(repo.join(".git/info/exclude"), "vendor/\n").unwrap();

    let b = backend(true);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let session = b.repos.session(id).unwrap();
    let watched = session.watched_dirs().unwrap();
    let git_dirs = walk(&repo.join(".git"))
        .into_iter()
        .filter(|d| {
            let rel = d.strip_prefix(repo.join(".git")).unwrap();
            !["objects", "logs", "hooks"]
                .iter()
                .any(|skipped| rel.starts_with(skipped))
        })
        .count();
    // Worktree: root, newdir (untracked), src, src/deep, src/deep/er, vendor.
    assert_eq!(watched, 6 + git_dirs, "watched {watched}");
    settle(&b);

    // A folder created later is watched: a file written in it afterwards is reported.
    std::fs::create_dir_all(repo.join("src/new")).unwrap();
    assert!(b.sink.wait_for(TIMEOUT, is_status));
    std::thread::sleep(Duration::from_millis(400));
    b.sink.clear();
    std::fs::write(repo.join("src/new/file.txt"), "x").unwrap();
    assert!(b.sink.wait_for(TIMEOUT, is_status));
    assert_eq!(session.watched_dirs(), Some(watched + 1));

    // A folder moved in from outside is watched too.
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(outside.path().join("moved/inner")).unwrap();
    std::fs::rename(outside.path().join("moved"), repo.join("src/moved")).unwrap();
    assert!(b.sink.wait_for(TIMEOUT, is_status));
    std::thread::sleep(Duration::from_millis(400));
    b.sink.clear();
    std::fs::write(repo.join("src/moved/inner/file.txt"), "x").unwrap();
    assert!(b.sink.wait_for(TIMEOUT, is_status));
    assert_eq!(session.watched_dirs(), Some(watched + 3));

    // Changes in ignored folders stay silent.
    b.sink.clear();
    std::fs::create_dir_all(repo.join("build/new")).unwrap();
    std::fs::write(repo.join("build/a/b/out.o"), "x").unwrap();
    std::thread::sleep(Duration::from_millis(400));
    assert!(!b.sink.events().iter().any(is_status));
    assert_eq!(session.watched_dirs(), Some(watched + 3));
}

/// Every folder under `root` (itself included).
fn walk(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = vec![root.to_path_buf()];
    let mut i = 0;
    while i < out.len() {
        if let Ok(entries) = std::fs::read_dir(&out[i]) {
            for entry in entries.flatten() {
                if entry.file_type().unwrap().is_dir() {
                    out.push(entry.path());
                }
            }
        }
        i += 1;
    }
    out
}

/// Watch count and open time on a real repository:
/// `YAGGUI_BENCH_REPO=<path> cargo test --release --test watcher watch_bench -- --ignored --nocapture`
#[test]
#[ignore]
fn watch_bench() {
    let Ok(path) = std::env::var("YAGGUI_BENCH_REPO") else {
        return;
    };
    for run in 0..3 {
        let b = backend(true);
        let started = std::time::Instant::now();
        let id = b.repos.open(&path).unwrap().id;
        let elapsed = started.elapsed();
        let watched = b.repos.session(id).unwrap().watched_dirs();
        println!("run {run}: open {elapsed:?}, watches {watched:?}");
    }
}
