//! Opening repositories and reading their state, on generated fixtures.

mod common;

use common::{Fixture, backend};
use yaggui_lib::git::errors::{ErrorAction, ErrorCode};
use yaggui_lib::git::read::state::{DirtyState, HeadState, RepoOperation, UpstreamState};

#[test]
fn clean_repo() {
    let fx = Fixture::new("clean");
    let b = backend(false);
    let info = b.repos.open(&fx.repo_str()).unwrap();

    assert_eq!(info.name, "repo");
    assert_eq!(info.path, fx.repo_str());
    assert!(
        matches!(&info.state.head, HeadState::Branch { name, oid } if name == "main" && oid.len() == 40)
    );
    assert_eq!(
        info.state.upstream,
        Some(UpstreamState {
            name: "origin/main".into(),
            ahead: 0,
            behind: 0,
            gone: false
        })
    );
    assert!(info.state.dirty.is_clean());
    assert_eq!(info.state.operation, None);
    assert_eq!(info.state.index_lock, None);

    // Recorded as a recent repo.
    let known = b.store.list_repos().unwrap();
    assert_eq!(known.len(), 1);
    assert_eq!(known[0].id, info.id);
    assert_eq!(known[0].path, fx.repo_str());
}

#[test]
fn dirty_repo_counts_match_git_status() {
    let fx = Fixture::new("dirty");
    let b = backend(false);
    let info = b.repos.open(&fx.repo_str()).unwrap();
    // `git status --porcelain -uall`: MM README.md, " M src.txt", "A  staged.txt",
    // ?? newdir/a.txt, ?? newdir/b.txt, ?? notes.txt: the counts of the changes panel.
    assert_eq!(
        info.state.dirty,
        DirtyState {
            staged: 2,
            unstaged: 2,
            untracked: 3,
            conflicted: 0
        }
    );
}

#[test]
fn detached_head() {
    let fx = Fixture::new("detached");
    let b = backend(false);
    let state = b.repos.open(&fx.repo_str()).unwrap().state;
    assert!(matches!(state.head, HeadState::Detached { ref oid } if oid.len() == 40));
    assert_eq!(state.upstream, None);
}

#[test]
fn ahead_and_behind() {
    let fx = Fixture::new("diverged");
    let b = backend(false);
    let upstream = b
        .repos
        .open(&fx.repo_str())
        .unwrap()
        .state
        .upstream
        .unwrap();
    assert_eq!((upstream.ahead, upstream.behind), (1, 2));
}

#[test]
fn gone_upstream() {
    let fx = Fixture::new("clean");
    fx.git(&["update-ref", "-d", "refs/remotes/origin/main"]);
    let b = backend(false);
    let upstream = b
        .repos
        .open(&fx.repo_str())
        .unwrap()
        .state
        .upstream
        .unwrap();
    assert!(upstream.gone);
    assert_eq!(upstream.name, "origin/main");
}

#[test]
fn rebase_in_progress() {
    let fx = Fixture::new("rebase");
    let b = backend(false);
    let state = b.repos.open(&fx.repo_str()).unwrap().state;
    let Some(RepoOperation::Rebase {
        step,
        total,
        head_name,
        ..
    }) = state.operation
    else {
        panic!("expected a rebase, got {:?}", state.operation);
    };
    assert_eq!((step, total), (Some(1), Some(2)));
    assert_eq!(head_name.as_deref(), Some("feature"));
    assert!(matches!(state.head, HeadState::Detached { .. }));
    assert_eq!(state.dirty.conflicted, 1);
}

#[test]
fn merge_in_progress() {
    let fx = Fixture::new("merge");
    let b = backend(false);
    let state = b.repos.open(&fx.repo_str()).unwrap().state;
    assert_eq!(
        state.operation,
        Some(RepoOperation::Merge { squash: false })
    );
    assert!(matches!(state.head, HeadState::Branch { ref name, .. } if name == "main"));
    assert_eq!(state.dirty.conflicted, 1);
}

#[test]
fn unborn_branch() {
    let fx = Fixture::new("unborn");
    let b = backend(false);
    let state = b.repos.open(&fx.repo_str()).unwrap().state;
    assert_eq!(
        state.head,
        HeadState::Unborn {
            name: "main".into()
        }
    );
    assert!(state.dirty.is_clean());
}

#[test]
fn stale_index_lock_is_reported_and_removable() {
    let fx = Fixture::new("stale-lock");
    let b = backend(false);
    let info = b.repos.open(&fx.repo_str()).unwrap();
    let lock = info.state.index_lock.expect("lock detected");
    assert!(lock.stale);
    assert!(lock.age_secs > 60);

    // Git itself refuses to write, and the catalog maps it with the removal action.
    let err = b
        .git
        .run(
            &yaggui_lib::git::cli::GitCommand::new(["commit", "--allow-empty", "-m", "x"])
                .cwd(fx.repo())
                .repo(info.id),
        )
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::IndexLocked);
    assert!(
        matches!(err.action, Some(ErrorAction::RemoveIndexLock { repo_id: Some(id), .. }) if id == info.id)
    );

    b.repos
        .remove_stale_index_lock(info.id, None)
        .unwrap()
        .wait()
        .unwrap();
    assert!(!fx.repo().join(".git/index.lock").exists());
    assert_eq!(b.repos.state(info.id).unwrap().index_lock, None);
}

#[test]
fn fresh_index_lock_is_not_removed() {
    let fx = Fixture::new("clean");
    std::fs::write(fx.repo().join(".git/index.lock"), "").unwrap();
    let b = backend(false);
    let info = b.repos.open(&fx.repo_str()).unwrap();
    assert!(!info.state.index_lock.as_ref().unwrap().stale);
    let err = b
        .repos
        .remove_stale_index_lock(info.id, None)
        .unwrap()
        .wait()
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::IndexLocked);
    assert!(fx.repo().join(".git/index.lock").exists());
}

#[test]
fn not_a_repository() {
    let fx = Fixture::new("not-a-repo");
    let b = backend(false);
    let err = b.repos.open(&fx.repo_str()).unwrap_err();
    assert_eq!(err.code, ErrorCode::NotARepository);
    assert!(b.store.list_repos().unwrap().is_empty());
}

#[test]
fn missing_and_relative_paths() {
    let b = backend(false);
    let missing = std::env::temp_dir().join("yaggui-definitely-missing-folder");
    let err = b.repos.open(&missing.to_string_lossy()).unwrap_err();
    assert_eq!(err.code, ErrorCode::RepoNotFound);
    let err = b.repos.open("relative/path").unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
}

#[test]
fn opening_a_subfolder_or_twice_reuses_the_session() {
    let fx = Fixture::new("dirty");
    let b = backend(false);
    let first = b.repos.open(&fx.repo_str()).unwrap();
    let sub = fx.repo().join("newdir");
    let second = b.repos.open(&sub.to_string_lossy()).unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(second.path, fx.repo_str());
    assert_eq!(b.store.list_repos().unwrap().len(), 1);
}

#[test]
fn closed_repo_is_not_readable() {
    let fx = Fixture::new("clean");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    b.repos.close(id);
    assert_eq!(b.repos.state(id).unwrap_err().code, ErrorCode::RepoNotOpen);
    // Reopening keeps the persisted id.
    assert_eq!(b.repos.open(&fx.repo_str()).unwrap().id, id);
}

#[test]
fn shared_session_survives_closing_one_tab() {
    let fx = Fixture::new("clean");
    let b = backend(false);
    // Two tabs on the same repo.
    let first = b.repos.open(&fx.repo_str()).unwrap().id;
    let second = b.repos.open(&fx.repo_str()).unwrap().id;
    assert_eq!(first, second);

    b.repos.close(first);
    assert!(
        b.repos.state(first).is_ok(),
        "the other tab lost its session"
    );

    b.repos.close(first);
    assert_eq!(
        b.repos.state(first).unwrap_err().code,
        ErrorCode::RepoNotOpen
    );
    // Extra closes are harmless.
    b.repos.close(first);
}

#[test]
fn forgetting_a_repo_closes_every_reference() {
    let fx = Fixture::new("clean");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    b.repos.open(&fx.repo_str()).unwrap();
    b.repos.close_all(id);
    assert_eq!(b.repos.state(id).unwrap_err().code, ErrorCode::RepoNotOpen);
}

#[test]
fn upstream_changes_made_outside_yaggui_are_seen() {
    let fx = Fixture::new("clean");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    assert!(b.repos.state(id).unwrap().upstream.is_some());

    fx.git(&["branch", "--unset-upstream"]);
    assert_eq!(b.repos.state(id).unwrap().upstream, None);

    fx.git(&["branch", "--set-upstream-to=origin/main"]);
    assert_eq!(
        b.repos.state(id).unwrap().upstream.map(|u| u.name),
        Some("origin/main".into())
    );
}

#[test]
fn linked_worktree() {
    let fx = Fixture::new("worktree");
    let b = backend(false);
    let wt = fx.root.join("wt");
    let info = b.repos.open(&wt.to_string_lossy()).unwrap();
    assert_eq!(info.path, wt.to_string_lossy());
    assert!(matches!(info.state.head, HeadState::Branch { ref name, .. } if name == "wt"));
    assert!(info.state.dirty.is_clean());
    // Main worktree and linked worktree are distinct repos for the UI.
    let main = b.repos.open(&fx.repo_str()).unwrap();
    assert_ne!(main.id, info.id);
}

#[test]
fn watcher_failure_is_reported_to_the_frontend() {
    let fx = Fixture::new("clean");
    let b = common::backend_with(yaggui_lib::repo::WatchMode::Failing(
        "inotify watch limit reached".into(),
    ));
    let info = b.repos.open(&fx.repo_str()).unwrap();
    let error = info.watch_error.expect("watch error exposed");
    assert_eq!(error.code, ErrorCode::WatchUnavailable);
    assert!(error.message.fr.contains("rafraîchissement automatique"));
    assert_eq!(error.detail.as_deref(), Some("inotify watch limit reached"));
    // The repository is still usable.
    assert!(b.repos.state(info.id).is_ok());

    let ok = backend(true).repos.open(&fx.repo_str()).unwrap();
    assert_eq!(ok.watch_error, None);
}

#[test]
fn stale_ref_locks_named_by_git_are_removable_but_nothing_else() {
    let fx = Fixture::new("clean");
    // The commit below must reach the ref update: it needs an identity on a bare runner.
    fx.git(&["config", "user.name", "yaggui Tests"]);
    fx.git(&["config", "user.email", "tests@yaggui.dev"]);
    let b = backend(false);
    let info = b.repos.open(&fx.repo_str()).unwrap();
    let git_dir = fx.repo().join(".git");
    let lock = git_dir.join("refs/heads/main.lock");
    std::fs::write(&lock, "").unwrap();
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(120);
    std::fs::File::options()
        .write(true)
        .open(&lock)
        .unwrap()
        .set_modified(old)
        .unwrap();

    // A stale lock on a ref: git refuses to move it, the catalog names the lock and offers
    // its removal, which removes that file.
    let err = b
        .git
        .run(
            &yaggui_lib::git::cli::GitCommand::new(["commit", "--allow-empty", "-m", "x"])
                .cwd(fx.repo())
                .repo(info.id),
        )
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::IndexLocked);
    assert!(err.message.en.contains("(main.lock)"), "{}", err.message.en);
    let Some(ErrorAction::RemoveIndexLock { path, .. }) = err.action else {
        panic!("no removal action: {err:?}");
    };
    assert!(path.ends_with("main.lock"), "{path}");
    b.repos
        .remove_stale_index_lock(info.id, Some(path))
        .unwrap()
        .wait()
        .unwrap();
    assert!(!lock.exists());

    // A fresh ref lock is refused like a fresh index.lock.
    std::fs::write(&lock, "").unwrap();
    let err = b
        .repos
        .remove_stale_index_lock(info.id, Some(lock.display().to_string()))
        .unwrap()
        .wait()
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::IndexLocked);
    assert!(lock.exists());

    // Only `.lock` files inside the git dir can be removed this way.
    let outside = fx.root.join("elsewhere.lock");
    std::fs::write(&outside, "").unwrap();
    for refused in [
        outside.display().to_string(),
        git_dir.join("HEAD").display().to_string(),
        git_dir.join("../../elsewhere.lock").display().to_string(),
        ".lock".to_owned(),
    ] {
        let err = match b
            .repos
            .remove_stale_index_lock(info.id, Some(refused.clone()))
        {
            Ok(_) => panic!("{refused} accepted"),
            Err(err) => err,
        };
        assert_eq!(err.code, ErrorCode::InvalidArgument, "{refused}");
    }
    assert!(outside.exists() && git_dir.join("HEAD").exists());
}

#[test]
fn upstream_pointing_at_a_missing_object_does_not_prevent_opening() {
    let fx = Fixture::new("clean");
    // A remote-tracking ref left pointing at a pruned object.
    let bogus = "a".repeat(40);
    std::fs::write(
        fx.repo().join(".git/refs/remotes/origin/main"),
        format!("{bogus}\n"),
    )
    .unwrap();
    let b = backend(false);
    let info = b.repos.open(&fx.repo_str()).unwrap();
    assert_eq!(info.state.upstream, None);
    assert!(matches!(info.state.head, HeadState::Branch { .. }));
    assert_eq!(b.repos.state(info.id).unwrap().upstream, None);
}

#[test]
fn a_revert_stopped_on_conflicts_during_a_bisect_is_the_current_operation() {
    let fx = Fixture::new("clean");
    fx.git(&["config", "user.name", "yaggui Tests"]);
    fx.git(&["config", "user.email", "tests@yaggui.dev"]);
    std::fs::write(fx.repo().join("src.txt"), "line 1\nline 2\n").unwrap();
    fx.git(&["commit", "-q", "-am", "edit src"]);
    fx.git(&["bisect", "start"]);
    // Reverting the commit that added src.txt deletes a file modified since: a conflict.
    let revert = std::process::Command::new("git")
        .args(["revert", "--no-edit", "HEAD~1"])
        .current_dir(fx.repo())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .output()
        .unwrap();
    assert!(!revert.status.success());
    assert!(fx.repo().join(".git/REVERT_HEAD").is_file());
    assert!(fx.repo().join(".git/BISECT_LOG").is_file());

    let b = backend(false);
    let info = b.repos.open(&fx.repo_str()).unwrap();
    assert_eq!(info.state.operation, Some(RepoOperation::Revert));
    assert_eq!(info.state.dirty.conflicted, 1);
}
