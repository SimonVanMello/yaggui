//! Assisted bisect (M7-9, F-263) on temporary repositories: start from a mark, good / bad /
//! skip steps up to the result, reset to the original HEAD, a bisect started outside yaggui
//! read back, a dirty tree, a step whose checkout fails, marks in the wrong order, a bisect
//! along first parents when the graph is in first-parent mode.

mod common;

use std::sync::Arc;

use common::{Fixture, RecordingSink};
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::errors::ErrorCode;
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::ops::types::{BisectMark, BisectResult, BisectState, BranchStart};
use yaggui_lib::git::read::state::{HeadState, RepoOperation};
use yaggui_lib::graph::types::GraphFilter;
use yaggui_lib::repo::RepoManager;
use yaggui_lib::store::Store;

/// Commits on top of the fixture; the bug (`bug.txt` saying `broken`) appears in `c6`.
const COMMITS: usize = 10;
const FIRST_BAD: usize = 6;

struct Env {
    fx: Fixture,
    repos: Arc<RepoManager>,
    id: u32,
    /// `shas[i]` is `c<i + 1>`.
    shas: Vec<String>,
}

fn manager(fx: &Fixture) -> (Arc<RepoManager>, u32) {
    let sink = Arc::new(RecordingSink::default());
    let git = GitCli::new(Arc::new(CommandLog::new()), sink.clone())
        .with_env("GIT_CONFIG_NOSYSTEM", "1")
        .with_env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        );
    let store = Arc::new(Store::open_in_memory().unwrap());
    let repos = Arc::new(
        RepoManager::new(Arc::new(git), store, sink)
            .without_watcher()
            .with_backup_dir(fx.root.join("backups")),
    );
    let id = repos.open(&fx.repo_str()).unwrap().id;
    (repos, id)
}

/// A `clean` fixture with `COMMITS` linear commits. `c3` adds `old.txt`, `c8` deletes it.
fn env() -> Env {
    let fx = Fixture::new("clean");
    fx.git(&["config", "user.name", "yaggui Tests"]);
    fx.git(&["config", "user.email", "tests@yaggui.dev"]);
    let mut shas = Vec::new();
    for i in 1..=COMMITS {
        let bug = if i >= FIRST_BAD { "broken\n" } else { "fine\n" };
        std::fs::write(fx.repo().join("bug.txt"), bug).unwrap();
        std::fs::write(fx.repo().join("n.txt"), format!("{i}\n")).unwrap();
        if i == 3 {
            std::fs::write(fx.repo().join("old.txt"), "old\n").unwrap();
        }
        if i == 8 {
            std::fs::remove_file(fx.repo().join("old.txt")).unwrap();
        }
        fx.git(&["add", "-A"]);
        fx.git(&["commit", "-q", "-m", &format!("c{i}")]);
        shas.push(rev(&fx, "HEAD"));
    }
    let (repos, id) = manager(&fx);
    Env {
        fx,
        repos,
        id,
        shas,
    }
}

fn rev(fx: &Fixture, rev: &str) -> String {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--verify", "-q", rev])
        .current_dir(fx.repo())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

impl Env {
    fn head(&self) -> String {
        rev(&self.fx, "HEAD")
    }

    fn mark(&self, rev: Option<&str>, mark: BisectMark) -> BisectState {
        self.repos
            .bisect_mark(self.id, rev.map(str::to_owned), mark)
            .unwrap()
    }

    fn state(&self) -> Option<BisectState> {
        self.repos.bisect_state(self.id).unwrap()
    }

    fn broken(&self) -> bool {
        std::fs::read_to_string(self.fx.repo().join("bug.txt")).unwrap() == "broken\n"
    }

    fn bisecting(&self) -> bool {
        self.repos.state(self.id).unwrap().operation == Some(RepoOperation::Bisect)
    }
}

#[test]
fn finds_the_first_bad_commit_and_resets() {
    let env = env();
    let tip = env.head();

    // Bad first: the bisect starts, nothing is checked out until a good commit is known.
    let state = env.mark(None, BisectMark::Bad);
    assert!(env.bisecting());
    assert_eq!(state.bad.as_deref(), Some(tip.as_str()));
    assert!(state.good.is_empty());
    assert_eq!(state.remaining, None);
    assert_eq!(state.original.as_deref(), Some("main"));
    assert_eq!(env.head(), tip);

    let mut state = env.mark(Some(&env.shas[0]), BisectMark::Good);
    assert_eq!(state.good, [env.shas[0].clone()]);
    // c2..c9 are left to test: Git says "roughly 2 steps".
    assert_eq!(state.remaining, Some(8));
    assert_eq!(state.steps, Some(2));
    assert_ne!(env.head(), tip);
    assert!(!state.awaiting_checkout);

    let mut steps = 0;
    while state.result.is_none() {
        let current = state.current.clone().unwrap();
        assert_eq!(current.sha, env.head());
        let mark = if env.broken() {
            BisectMark::Bad
        } else {
            BisectMark::Good
        };
        state = env.mark(None, mark);
        steps += 1;
        assert!(steps <= 4, "too many steps");
    }
    match state.result {
        Some(BisectResult::Found { commit }) => {
            assert_eq!(commit.sha, env.shas[FIRST_BAD - 1]);
            assert_eq!(commit.summary, format!("c{FIRST_BAD}"));
            assert_eq!(commit.author_name, "yaggui Tests");
        }
        other => panic!("unexpected result {other:?}"),
    }
    assert_eq!(state.remaining, Some(0));

    // Reset: back on main, at its tip, no bisect left.
    env.repos.abort_operation(env.id).unwrap();
    assert!(!env.bisecting());
    assert!(env.state().is_none());
    assert_eq!(env.head(), tip);
    match env.repos.state(env.id).unwrap().head {
        HeadState::Branch { name, .. } => assert_eq!(name, "main"),
        other => panic!("HEAD not on main: {other:?}"),
    }
}

#[test]
fn skipping_every_commit_ends_inconclusive() {
    let env = env();
    env.mark(Some(&env.shas[COMMITS - 1]), BisectMark::Bad);
    let mut state = env.mark(Some(&env.shas[COMMITS - 4]), BisectMark::Good);
    // c8 and c9 are left.
    assert_eq!(state.remaining, Some(2));
    let mut skipped = Vec::new();
    while state.result.is_none() {
        skipped.push(env.head());
        state = env.mark(None, BisectMark::Skip);
        assert!(skipped.len() <= 2, "skipped more than the candidates");
    }
    assert_eq!(state.skipped.len(), 2);
    for sha in &skipped {
        assert!(state.skipped.contains(sha));
    }
    match state.result {
        Some(BisectResult::Inconclusive { candidates }) => {
            let shas: Vec<_> = candidates.iter().map(|c| c.sha.as_str()).collect();
            assert_eq!(shas.len(), 3);
            for i in [COMMITS - 3, COMMITS - 2, COMMITS - 1] {
                assert!(shas.contains(&env.shas[i].as_str()));
            }
        }
        other => panic!("unexpected result {other:?}"),
    }
}

#[test]
fn skip_from_the_graph_marks_that_commit() {
    let env = env();
    env.mark(None, BisectMark::Bad);
    env.mark(Some(&env.shas[0]), BisectMark::Good);
    let other = env.shas[1].clone();
    let state = env.mark(Some(&other), BisectMark::Skip);
    assert_eq!(state.skipped, [other]);
    assert_eq!(state.remaining, Some(7));
}

#[test]
fn reads_back_an_interrupted_bisect() {
    let env = env();
    // Started in a terminal (or by a previous session of the app).
    env.fx
        .git(&["bisect", "start", &env.shas[COMMITS - 1], &env.shas[1]]);
    env.fx.git(&["bisect", "skip"]);
    let tested = env.head();
    drop(env.repos);

    let (repos, id) = manager(&env.fx);
    assert_eq!(
        repos.state(id).unwrap().operation,
        Some(RepoOperation::Bisect)
    );
    let state = repos.bisect_state(id).unwrap().unwrap();
    assert_eq!(state.bad.as_deref(), Some(env.shas[COMMITS - 1].as_str()));
    assert_eq!(state.good, [env.shas[1].clone()]);
    assert_eq!(state.skipped.len(), 1);
    assert_eq!(state.current.map(|c| c.sha), Some(tested));
    assert_eq!(state.original.as_deref(), Some("main"));
    assert!(state.result.is_none());
    assert!(!state.awaiting_checkout);
    // c3..c9 minus the skipped one.
    assert_eq!(state.remaining, Some(6));

    // And it goes on from yaggui.
    let state = repos.bisect_mark(id, None, BisectMark::Good).unwrap();
    assert_eq!(state.good.len(), 2);
}

#[test]
fn refuses_a_dirty_tree_and_keeps_untracked_files() {
    let env = env();
    std::fs::write(env.fx.repo().join("n.txt"), "local change\n").unwrap();
    let err = env
        .repos
        .bisect_mark(env.id, None, BisectMark::Bad)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree);
    assert!(!env.bisecting(), "no bisect started");
    env.fx.git(&["checkout", "--", "n.txt"]);

    std::fs::write(env.fx.repo().join("notes.txt"), "mine\n").unwrap();
    env.mark(None, BisectMark::Bad);
    env.mark(Some(&env.shas[0]), BisectMark::Good);
    assert_eq!(
        std::fs::read_to_string(env.fx.repo().join("notes.txt")).unwrap(),
        "mine\n"
    );

    // During the bisect too: the mark is refused and not recorded.
    std::fs::write(env.fx.repo().join("bug.txt"), "edited\n").unwrap();
    let err = env
        .repos
        .bisect_mark(env.id, None, BisectMark::Good)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree);
    assert_eq!(env.state().unwrap().good.len(), 1);
}

#[test]
fn a_step_whose_checkout_fails_keeps_the_mark() {
    let env = env();
    // `old.txt` is untracked at the tip but tracked in c3..c7, where the bisect goes next.
    std::fs::write(env.fx.repo().join("old.txt"), "in the way\n").unwrap();
    env.mark(None, BisectMark::Bad);
    let err = env
        .repos
        .bisect_mark(env.id, Some(env.shas[0].clone()), BisectMark::Good)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::BisectCheckoutFailed);
    let state = env.state().unwrap();
    assert_eq!(state.good, [env.shas[0].clone()]);
    assert!(state.awaiting_checkout);
    assert_eq!(env.head(), env.shas[COMMITS - 1]);

    std::fs::remove_file(env.fx.repo().join("old.txt")).unwrap();
    let state = env.repos.bisect_next(env.id).unwrap();
    assert!(!state.awaiting_checkout);
    assert_ne!(env.head(), env.shas[COMMITS - 1]);
}

#[test]
fn marks_in_the_wrong_order_are_reported() {
    let env = env();
    env.mark(Some(&env.shas[0]), BisectMark::Bad);
    let err = env
        .repos
        .bisect_mark(env.id, None, BisectMark::Good)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::BisectWrongOrder);
}

#[test]
fn skip_needs_a_bisect_and_undo_waits_for_its_end() {
    let env = env();
    let err = env
        .repos
        .bisect_mark(env.id, None, BisectMark::Skip)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    assert!(!env.bisecting());

    env.repos
        .create_branch(env.id, "topic", BranchStart::Head, false)
        .unwrap();
    env.mark(None, BisectMark::Bad);
    env.mark(Some(&env.shas[0]), BisectMark::Good);
    let err = env.repos.undo(env.id).unwrap_err();
    assert_eq!(err.code, ErrorCode::OperationInProgress);

    env.repos.abort_operation(env.id).unwrap();
    env.repos.undo(env.id).unwrap();
    assert_eq!(rev(&env.fx, "refs/heads/topic"), "");
}

/// `main`: m1 – m2 – merge(side) – m3 – m4, `side` (from m1): s1 – s2 – s3, the bug in s2.
/// Returns (repos, id, main first parents oldest first, side commits).
fn merged_env() -> (Fixture, Arc<RepoManager>, u32, Vec<String>, Vec<String>) {
    let fx = Fixture::new("clean");
    fx.git(&["config", "user.name", "yaggui Tests"]);
    fx.git(&["config", "user.email", "tests@yaggui.dev"]);
    let commit = |file: &str, content: &str, message: &str| {
        std::fs::write(fx.repo().join(file), content).unwrap();
        fx.git(&["add", "-A"]);
        fx.git(&["commit", "-q", "-m", message]);
        rev(&fx, "HEAD")
    };
    std::fs::write(fx.repo().join("bug.txt"), "fine\n").unwrap();
    let mut main = vec![commit("m.txt", "1\n", "m1")];
    fx.git(&["switch", "-q", "-c", "side"]);
    let mut side = vec![commit("s.txt", "1\n", "s1")];
    std::fs::write(fx.repo().join("bug.txt"), "broken\n").unwrap();
    side.push(commit("s.txt", "2\n", "s2"));
    side.push(commit("s.txt", "3\n", "s3"));
    fx.git(&["switch", "-q", "main"]);
    main.push(commit("m.txt", "2\n", "m2"));
    fx.git(&["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    main.push(rev(&fx, "HEAD"));
    main.push(commit("m.txt", "3\n", "m3"));
    main.push(commit("m.txt", "4\n", "m4"));
    let (repos, id) = manager(&fx);
    (fx, repos, id, main, side)
}

#[test]
fn first_parent_mode_bisects_along_first_parents() {
    let (fx, repos, id, main, side) = merged_env();
    repos
        .set_graph_filter(
            id,
            GraphFilter {
                first_parent: true,
                ..GraphFilter::default()
            },
        )
        .unwrap();
    let mark =
        |rev: Option<&str>, mark| repos.bisect_mark(id, rev.map(str::to_owned), mark).unwrap();
    let broken = || std::fs::read_to_string(fx.repo().join("bug.txt")).unwrap() == "broken\n";

    mark(None, BisectMark::Bad);
    assert!(fx.repo().join(".git/BISECT_FIRST_PARENT").exists());
    let mut state = mark(Some(&main[0]), BisectMark::Good);
    assert!(state.first_parent);
    // m2, merge and m3 are left (side's commits are not), m4 the bad one: "roughly 1 step".
    assert_eq!(state.remaining, Some(3));
    let out = std::process::Command::new("git")
        .args([
            "rev-list",
            "--count",
            "--first-parent",
            &main[4],
            "--not",
            &main[0],
        ])
        .current_dir(fx.repo())
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "4",
        "what Git counts"
    );
    assert_eq!(state.steps, Some(1));
    let mut tested = Vec::new();
    while state.result.is_none() {
        let head = rev(&fx, "HEAD");
        assert!(main.contains(&head), "only first parents are tested");
        assert_eq!(
            state.current.as_ref().map(|c| c.sha.as_str()),
            Some(head.as_str())
        );
        tested.push(head);
        let next = if broken() {
            BisectMark::Bad
        } else {
            BisectMark::Good
        };
        state = mark(None, next);
    }
    assert!(tested.iter().all(|sha| !side.contains(sha)));
    // The merge brought the bug in, as far as first parents tell.
    match state.result {
        Some(BisectResult::Found { commit }) => assert_eq!(commit.sha, main[2]),
        other => panic!("{other:?}"),
    }
    assert_eq!(state.remaining, Some(0));
}

#[test]
fn without_first_parent_mode_the_side_branch_is_bisected() {
    let (fx, repos, id, main, side) = merged_env();
    let mark =
        |rev: Option<&str>, mark| repos.bisect_mark(id, rev.map(str::to_owned), mark).unwrap();
    let broken = || std::fs::read_to_string(fx.repo().join("bug.txt")).unwrap() == "broken\n";
    mark(None, BisectMark::Bad);
    assert!(!fx.repo().join(".git/BISECT_FIRST_PARENT").exists());
    let mut state = mark(Some(&main[0]), BisectMark::Good);
    assert!(!state.first_parent);
    // m2, merge, m3 and s1..s3.
    assert_eq!(state.remaining, Some(6));
    while state.result.is_none() {
        let next = if broken() {
            BisectMark::Bad
        } else {
            BisectMark::Good
        };
        state = mark(None, next);
    }
    match state.result {
        Some(BisectResult::Found { commit }) => assert_eq!(commit.sha, side[1]),
        other => panic!("{other:?}"),
    }
}

#[test]
fn first_parent_mode_turned_on_during_a_bisect_changes_nothing() {
    let (fx, repos, id, main, _) = merged_env();
    repos.bisect_mark(id, None, BisectMark::Bad).unwrap();
    repos
        .set_graph_filter(
            id,
            GraphFilter {
                first_parent: true,
                ..GraphFilter::default()
            },
        )
        .unwrap();
    let state = repos
        .bisect_mark(id, Some(main[0].clone()), BisectMark::Good)
        .unwrap();
    // The mode is the one the bisect started with.
    assert!(!state.first_parent);
    assert_eq!(state.remaining, Some(6));
    assert!(!fx.repo().join(".git/BISECT_FIRST_PARENT").exists());
}
