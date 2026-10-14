//! Workspaces (M4-3, F-006 to F-009) on generated fixtures: overview of repos that are not
//! open, fetch through the repo queue, import of scanned folders, relocation of a moved repo.

mod common;

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use common::{Fixture, backend};
use yaggui_lib::events::{BackendEvent, NullSink, OpKind, OpOutcome};
use yaggui_lib::git::errors::ErrorCode;
use yaggui_lib::repo::scan::{RepoScanner, ScanRequest};
use yaggui_lib::repo::workspace::RepoOverview;

fn rev(dir: &Path, rev: &str) -> String {
    let out = Command::new("git")
        .args(["rev-parse", rev])
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(out.status.success());
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

/// A clone of the fixture's origin pushes one commit: the fixture repo is now behind.
fn teammate_pushes(fx: &Fixture) -> String {
    let other = fx.root.join("other");
    fx.git_in(
        &fx.root,
        &["clone", "-q", "origin.git", other.to_str().unwrap()],
    );
    std::fs::write(other.join("theirs.txt"), "theirs\n").unwrap();
    fx.git_in(&other, &["add", "theirs.txt"]);
    fx.git_in(&other, &["commit", "-q", "-m", "theirs"]);
    fx.git_in(&other, &["push", "-q", "origin", "main"]);
    rev(&other, "HEAD")
}

#[test]
fn overview_reads_repos_that_are_not_open() {
    let fx = Fixture::new("dirty");
    let b = backend(false);
    let imported = b.repos.import_repos(&[fx.repo_str()], None).unwrap();
    let id = imported.repo_ids[0];
    assert!(b.repos.get(id).is_none());

    let RepoOverview::Ready {
        state,
        last_fetched_at,
    } = b.repos.repo_overview(id).unwrap()
    else {
        panic!("expected a readable repo");
    };
    // Same counts as `repo_state` on this fixture (tests/repo_state.rs).
    assert_eq!(
        (
            state.dirty.staged,
            state.dirty.unstaged,
            state.dirty.untracked
        ),
        (2, 2, 3)
    );
    assert_eq!(state.upstream.map(|u| u.name), Some("origin/main".into()));
    assert_eq!(last_fetched_at, None);
    // Reading never opens a session.
    assert!(b.repos.get(id).is_none());

    // A folder that is gone, or no longer holds a repository, is reported as missing.
    std::fs::remove_dir_all(fx.repo().join(".git")).unwrap();
    assert_eq!(b.repos.repo_overview(id).unwrap(), RepoOverview::Missing);
    std::fs::remove_dir_all(fx.repo()).unwrap();
    assert_eq!(b.repos.repo_overview(id).unwrap(), RepoOverview::Missing);
    assert_eq!(
        b.repos.repo_overview(999).unwrap_err().code,
        ErrorCode::InvalidArgument
    );
}

#[test]
fn fetch_known_fetches_through_the_queue_and_releases_its_session() {
    let fx = Fixture::new("clean");
    let pushed = teammate_pushes(&fx);
    let b = backend(false);
    let id = b
        .repos
        .import_repos(&[fx.repo_str()], None)
        .unwrap()
        .repo_ids[0];

    b.repos.fetch_known(id, true).unwrap();
    assert_eq!(rev(&fx.repo(), "origin/main"), pushed);
    // The session opened for the fetch is gone, and the repo did not become "recent".
    assert!(b.repos.get(id).is_none());
    assert_eq!(b.store.repo(id).unwrap().unwrap().last_opened_at, 0);
    let fetches: Vec<_> = b
        .sink
        .events()
        .into_iter()
        .filter_map(|event| match event {
            BackendEvent::OpFinished(e) if e.repo_id == id => Some((e.kind, e.outcome)),
            _ => None,
        })
        .collect();
    assert!(matches!(
        fetches.as_slice(),
        [(OpKind::Fetch, OpOutcome::Success { .. })]
    ));
    let RepoOverview::Ready {
        last_fetched_at, ..
    } = b.repos.repo_overview(id).unwrap()
    else {
        panic!("expected a readable repo");
    };
    assert!(last_fetched_at.is_some());
}

#[test]
fn fetch_known_joins_the_session_of_an_open_tab() {
    let fx = Fixture::new("clean");
    let pushed = teammate_pushes(&fx);
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    b.repos.fetch_known(id, false).unwrap();
    assert_eq!(rev(&fx.repo(), "origin/main"), pushed);
    // The tab's session is still open, with its single reference.
    assert!(b.repos.get(id).is_some());
    b.repos.close(id);
    assert!(b.repos.get(id).is_none());
}

#[test]
fn fetch_known_reports_a_missing_folder() {
    let fx = Fixture::new("clean");
    let b = backend(false);
    let id = b
        .repos
        .import_repos(&[fx.repo_str()], None)
        .unwrap()
        .repo_ids[0];
    std::fs::remove_dir_all(fx.repo()).unwrap();
    assert_eq!(
        b.repos.fetch_known(id, false).unwrap_err().code,
        ErrorCode::RepoNotFound
    );
}

#[test]
fn import_keeps_worktree_roots_only_and_fills_the_workspace() {
    let fx = Fixture::new("clean");
    let b = backend(false);
    let ws = b.store.create_workspace("w", &[]).unwrap();
    let paths = vec![
        fx.repo_str(),
        fx.repo_str(), // twice: imported once
        fx.repo().join("sub").to_string_lossy().into_owned(),
        fx.root.to_string_lossy().into_owned(), // not a repository
        fx.root.join("origin.git").to_string_lossy().into_owned(), // bare
    ];
    std::fs::create_dir(fx.repo().join("sub")).unwrap();
    let result = b.repos.import_repos(&paths, Some(ws.id)).unwrap();
    assert_eq!(result.repo_ids.len(), 1);
    let failed: Vec<_> = result.failed.iter().map(|f| f.error.code).collect();
    assert_eq!(
        failed,
        vec![
            ErrorCode::NotARepository,
            ErrorCode::NotARepository,
            ErrorCode::InvalidArgument
        ]
    );
    let known = b.store.repo(result.repo_ids[0]).unwrap().unwrap();
    assert_eq!(known.path, fx.repo_str());
    assert_eq!(known.name, "repo");
    assert_eq!(b.store.workspace(ws.id).unwrap().repo_ids, result.repo_ids);
    assert!(b.repos.import_repos(&paths, Some(999)).is_err());
}

#[test]
fn relocate_points_a_moved_repo_to_its_new_folder() {
    let fx = Fixture::new("clean");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let moved = fx.root.join("moved");
    std::fs::rename(fx.repo(), &moved).unwrap();
    assert!(!b.store.repo(id).unwrap().unwrap().exists);

    // The folder must be a worktree root.
    assert_eq!(
        b.repos
            .relocate_repo(id, &fx.root.to_string_lossy())
            .unwrap_err()
            .code,
        ErrorCode::NotARepository
    );
    let relocated = b.repos.relocate_repo(id, &moved.to_string_lossy()).unwrap();
    assert_eq!(relocated.id, id);
    assert_eq!(relocated.name, "moved");
    assert!(relocated.exists);
    // The stale session was dropped; the repo opens again from its new folder.
    assert!(b.repos.get(id).is_none());
    assert!(matches!(
        b.repos.repo_overview(id).unwrap(),
        RepoOverview::Ready { .. }
    ));
    assert_eq!(b.repos.open(&moved.to_string_lossy()).unwrap().id, id);
}

#[test]
fn scan_finds_the_fixture_repos_but_not_the_bare_remote() {
    let fx = Fixture::new("clean");
    teammate_pushes(&fx);
    let b = backend(false);
    let known = b.repos.open(&fx.repo_str()).unwrap().id;
    let scanner = RepoScanner::new(b.store.clone(), Arc::new(NullSink));
    let result = scanner
        .scan(&ScanRequest {
            scan_id: "s".into(),
            root: fx.root.to_string_lossy().into_owned(),
            max_depth: 2,
        })
        .unwrap();
    let found: Vec<_> = result
        .repos
        .iter()
        .map(|r| (r.name.as_str(), r.known_id))
        .collect();
    assert_eq!(found, vec![("other", None), ("repo", Some(known))]);
}
