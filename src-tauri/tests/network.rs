//! Fetch, pull and push (M2-5) against a local bare remote reached through `file://`:
//! each test checks the resulting Git state on both sides.

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{Fixture, RecordingSink};
use yaggui_lib::events::{BackendEvent, OpKind, OpOutcome};
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::errors::{ErrorAction, ErrorCode, ErrorPayload, YagguiError};
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::ops::types::{FetchTarget, PullStrategy, PushRequest};
use yaggui_lib::git::read::state::RepoOperation;
use yaggui_lib::repo::RepoManager;
use yaggui_lib::store::{Preferences, Store};

struct Env {
    fx: Fixture,
    sink: Arc<RecordingSink>,
    repos: Arc<RepoManager>,
    store: Arc<Store>,
    log: Arc<CommandLog>,
    id: u32,
}

fn env() -> Env {
    let fx = Fixture::new("clean");
    for dir in [fx.repo(), fx.root.join("origin.git")] {
        git_at(&dir, &["config", "user.name", "yaggui Tests"]);
        git_at(&dir, &["config", "user.email", "tests@yaggui.dev"]);
    }
    let url = format!("file://{}", fx.root.join("origin.git").display());
    fx.git(&["remote", "set-url", "origin", &url]);
    // A second clone stands in for a teammate pushing to the same remote.
    git_at(&fx.root, &["clone", "-q", &url, "other"]);
    git_at(&fx.root.join("other"), &["config", "user.name", "Other"]);
    git_at(
        &fx.root.join("other"),
        &["config", "user.email", "o@yaggui.dev"],
    );
    let sink = Arc::new(RecordingSink::default());
    let log = Arc::new(CommandLog::new());
    let git = GitCli::new(log.clone(), sink.clone())
        .with_env("GIT_CONFIG_NOSYSTEM", "1")
        .with_env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        );
    let store = Arc::new(Store::open_in_memory().unwrap());
    let repos = Arc::new(
        RepoManager::new(Arc::new(git), store.clone(), sink.clone())
            .without_watcher()
            .with_backup_dir(fx.root.join("backups")),
    );
    let id = repos.open(&fx.repo_str()).unwrap().id;
    Env {
        fx,
        sink,
        repos,
        store,
        log,
        id,
    }
}

fn git_at(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

impl Env {
    fn other(&self) -> PathBuf {
        self.fx.root.join("other")
    }

    fn origin(&self) -> PathBuf {
        self.fx.root.join("origin.git")
    }

    fn rev(&self, rev: &str) -> String {
        git_at(&self.fx.repo(), &["rev-parse", "--verify", "-q", rev])
    }

    fn commit_in(&self, dir: &Path, file: &str, content: &str) -> String {
        std::fs::write(dir.join(file), content).unwrap();
        git_at(dir, &["add", "--", file]);
        git_at(dir, &["commit", "-q", "-m", &format!("edit {file}")]);
        git_at(dir, &["rev-parse", "HEAD"])
    }

    /// A commit pushed to `origin/main` by the other clone.
    fn teammate_pushes(&self, file: &str) -> String {
        let sha = self.commit_in(&self.other(), file, "theirs\n");
        git_at(&self.other(), &["push", "-q", "origin", "main"]);
        sha
    }

    fn remote_rev(&self, rev: &str) -> String {
        git_at(&self.origin(), &["rev-parse", rev])
    }

    fn push(
        &self,
        request: PushRequest,
    ) -> Result<yaggui_lib::git::ops::types::PushResult, YagguiError> {
        self.repos.push(self.id, request)
    }
}

fn push_request() -> PushRequest {
    PushRequest {
        branch: None,
        set_upstream: false,
        remote: None,
        force_with_lease: false,
        expected_sha: None,
    }
}

fn code<T: std::fmt::Debug>(result: Result<T, YagguiError>) -> ErrorCode {
    result.expect_err("expected an error").code
}

#[test]
fn fetch_updates_tracking_refs_and_reports_progress() {
    let env = env();
    let sha = env.teammate_pushes("t.txt");
    env.repos
        .fetch(
            env.id,
            FetchTarget::Remote {
                name: "origin".into(),
            },
            false,
        )
        .unwrap();
    assert_eq!(env.rev("refs/remotes/origin/main"), sha);
    assert!(env.sink.events().iter().any(|e| matches!(
        e,
        BackendEvent::OpFinished(f) if f.kind == OpKind::Fetch && matches!(f.outcome, OpOutcome::Success { .. })
    )));
    assert!(
        env.log
            .entries()
            .iter()
            .any(|e| e.args.contains(&"--progress".to_owned()))
    );

    assert_eq!(
        code(env.repos.fetch(
            env.id,
            FetchTarget::Remote {
                name: "nope".into()
            },
            false
        )),
        ErrorCode::RemoteNotFound
    );
    env.repos.fetch(env.id, FetchTarget::All, false).unwrap();
}

#[test]
fn fetch_prune_removes_deleted_remote_branches() {
    let env = env();
    git_at(&env.other(), &["push", "-q", "origin", "main:gone"]);
    env.repos.fetch(env.id, FetchTarget::All, false).unwrap();
    assert!(!env.rev("refs/remotes/origin/gone").is_empty());
    git_at(&env.other(), &["push", "-q", "origin", "--delete", "gone"]);
    env.repos.fetch(env.id, FetchTarget::All, false).unwrap();
    assert!(
        !env.rev("refs/remotes/origin/gone").is_empty(),
        "kept without prune"
    );
    env.repos.fetch(env.id, FetchTarget::All, true).unwrap();
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--verify", "-q", "refs/remotes/origin/gone"])
        .current_dir(env.fx.repo())
        .output()
        .unwrap();
    assert!(!out.status.success(), "pruned");
}

#[test]
fn pull_fast_forward_only() {
    let env = env();
    let sha = env.teammate_pushes("t.txt");
    let result = env.repos.pull(env.id, Some(PullStrategy::FfOnly)).unwrap();
    assert!(!result.up_to_date);
    assert_eq!(env.rev("HEAD"), sha);
    let again = env.repos.pull(env.id, Some(PullStrategy::FfOnly)).unwrap();
    assert!(again.up_to_date);

    // Diverged: ff-only refuses and leaves HEAD alone.
    env.teammate_pushes("t2.txt");
    let local = env.commit_in(&env.fx.repo(), "mine.txt", "mine\n");
    assert_eq!(
        code(env.repos.pull(env.id, Some(PullStrategy::FfOnly))),
        ErrorCode::NotFastForward
    );
    assert_eq!(env.rev("HEAD"), local);
}

#[test]
fn pull_merge_creates_a_merge_commit_when_diverged() {
    let env = env();
    let theirs = env.teammate_pushes("t.txt");
    let mine = env.commit_in(&env.fx.repo(), "mine.txt", "mine\n");
    let result = env.repos.pull(env.id, Some(PullStrategy::Merge)).unwrap();
    assert_eq!(result.strategy, PullStrategy::Merge);
    assert_eq!(env.rev("HEAD^1"), mine);
    assert_eq!(env.rev("HEAD^2"), theirs);
}

#[test]
fn pull_rebase_replays_local_commits() {
    let env = env();
    let theirs = env.teammate_pushes("t.txt");
    env.commit_in(&env.fx.repo(), "mine.txt", "mine\n");
    env.repos.pull(env.id, Some(PullStrategy::Rebase)).unwrap();
    assert_eq!(env.rev("HEAD~1"), theirs);
    assert_eq!(
        git_at(&env.fx.repo(), &["log", "-1", "--format=%s"]),
        "edit mine.txt"
    );
}

#[test]
fn pull_uses_the_configured_default_and_reports_conflicts() {
    let env = env();
    git_at(&env.fx.repo(), &["config", "pull.rebase", "true"]);
    assert_eq!(
        env.repos.pull_default_strategy(env.id).unwrap(),
        PullStrategy::Rebase
    );
    env.teammate_pushes("src.txt");
    env.commit_in(&env.fx.repo(), "src.txt", "mine\n");
    let err = env.repos.pull(env.id, None).unwrap_err();
    // Same error as a rebase stopped on conflicts (M3-1): operation and paths in the payload.
    assert_eq!(err.code, ErrorCode::Conflicts);
    assert!(err.message.fr.contains("rebase est en cours"));
    match err.payload.as_deref() {
        Some(ErrorPayload::Conflicts { operation, paths }) => {
            assert!(matches!(operation, Some(RepoOperation::Rebase { .. })));
            assert_eq!(paths, &["src.txt"]);
        }
        other => panic!("expected a conflicts payload, got {other:?}"),
    }
    let state = env.repos.state(env.id).unwrap();
    assert!(state.operation.is_some(), "rebase left in progress");
}

#[test]
fn pull_without_upstream_is_refused() {
    let env = env();
    git_at(&env.fx.repo(), &["switch", "-q", "-c", "lonely"]);
    assert_eq!(code(env.repos.pull(env.id, None)), ErrorCode::NoUpstream);
}

#[test]
fn first_push_sets_the_upstream() {
    let env = env();
    git_at(&env.fx.repo(), &["switch", "-q", "-c", "feat/x"]);
    let sha = env.commit_in(&env.fx.repo(), "x.txt", "x\n");
    let err = env.push(push_request()).unwrap_err();
    assert_eq!(err.code, ErrorCode::NoUpstream);
    assert_eq!(err.action, Some(ErrorAction::PushSetUpstream));

    let result = env
        .push(PushRequest {
            set_upstream: true,
            ..push_request()
        })
        .unwrap();
    assert!(result.upstream_set);
    assert_eq!(result.remote, "origin");
    assert_eq!(result.remote_branch, "feat/x");
    assert_eq!(env.remote_rev("refs/heads/feat/x"), sha);
    assert_eq!(
        git_at(
            &env.fx.repo(),
            &["rev-parse", "--abbrev-ref", "@{upstream}"]
        ),
        "origin/feat/x"
    );
    // Then a plain push goes to the upstream.
    let next = env.commit_in(&env.fx.repo(), "x.txt", "y\n");
    let again = env.push(push_request()).unwrap();
    assert!(!again.upstream_set && !again.up_to_date);
    assert_eq!(env.remote_rev("refs/heads/feat/x"), next);
    assert!(env.push(push_request()).unwrap().up_to_date);
}

#[test]
fn non_fast_forward_push_is_rejected_with_pull_then_push() {
    let env = env();
    let theirs = env.teammate_pushes("t.txt");
    env.commit_in(&env.fx.repo(), "mine.txt", "mine\n");
    let err = env.push(push_request()).unwrap_err();
    assert_eq!(err.code, ErrorCode::PushRejected);
    assert_eq!(err.action, Some(ErrorAction::PullThenPush));
    assert!(err.message.fr.contains("commits que tu n'as pas"));
    assert_eq!(env.remote_rev("refs/heads/main"), theirs);
}

#[test]
fn force_with_lease_is_refused_on_protected_branches() {
    let env = env();
    let before = env.remote_rev("refs/heads/main");
    git_at(
        &env.fx.repo(),
        &["commit", "-q", "--amend", "-m", "rewritten"],
    );
    let err = env
        .push(PushRequest {
            force_with_lease: true,
            ..push_request()
        })
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ProtectedBranch);
    assert_eq!(env.remote_rev("refs/heads/main"), before);
    assert!(
        env.repos
            .force_push_preview(env.id, None)
            .unwrap()
            .protected
    );
}

#[test]
fn force_with_lease_overwrites_only_what_was_seen() {
    let env = env();
    git_at(&env.fx.repo(), &["switch", "-q", "-c", "feat"]);
    env.commit_in(&env.fx.repo(), "f.txt", "1\n");
    env.push(PushRequest {
        set_upstream: true,
        ..push_request()
    })
    .unwrap();
    // Rewrite the pushed commit: a plain push is rejected, a leased one goes through.
    git_at(
        &env.fx.repo(),
        &["commit", "-q", "--amend", "-m", "amended"],
    );
    assert_eq!(code(env.push(push_request())), ErrorCode::PushRejected);
    let preview = env.repos.force_push_preview(env.id, None).unwrap();
    assert!(!preview.protected);
    assert_eq!(preview.overwritten.len(), 1);
    assert_eq!(preview.overwritten[0].summary, "edit f.txt");
    env.push(PushRequest {
        force_with_lease: true,
        expected_sha: preview.remote_sha.clone(),
        ..push_request()
    })
    .unwrap();
    assert_eq!(env.remote_rev("refs/heads/feat"), env.rev("HEAD"));

    // The remote moves behind our back: the lease (last fetched SHA) no longer holds.
    git_at(&env.other(), &["fetch", "-q", "origin"]);
    git_at(&env.other(), &["switch", "-q", "-c", "feat", "origin/feat"]);
    let theirs = env.commit_in(&env.other(), "g.txt", "theirs\n");
    git_at(&env.other(), &["push", "-q", "origin", "feat"]);
    git_at(
        &env.fx.repo(),
        &["commit", "-q", "--amend", "-m", "amended again"],
    );
    let err = env
        .push(PushRequest {
            force_with_lease: true,
            ..push_request()
        })
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::StaleLease);
    assert_eq!(env.remote_rev("refs/heads/feat"), theirs);
}

#[test]
fn tags_and_remote_branches_can_be_pushed_and_deleted() {
    let env = env();
    git_at(&env.fx.repo(), &["tag", "v1"]);
    env.repos.push_tag(env.id, "origin", "v1").unwrap();
    assert_eq!(env.remote_rev("refs/tags/v1"), env.rev("HEAD"));
    env.repos.delete_remote_tag(env.id, "origin", "v1").unwrap();
    assert!(git_at(&env.origin(), &["tag", "-l", "v1"]).is_empty());

    git_at(&env.fx.repo(), &["push", "-q", "origin", "main:old"]);
    git_at(&env.fx.repo(), &["fetch", "-q"]);
    let deleted = env
        .repos
        .delete_remote_branch(env.id, "origin", "old")
        .unwrap()
        .unwrap();
    assert_eq!(deleted.full_name, "refs/remotes/origin/old");
    assert!(git_at(&env.origin(), &["branch", "--list", "old"]).is_empty());
    assert!(git_at(&env.fx.repo(), &["branch", "-r", "--list", "origin/old"]).is_empty());
}

#[test]
fn unreachable_remotes_are_classified() {
    let env = env();
    git_at(
        &env.fx.repo(),
        &[
            "remote",
            "add",
            "missing",
            &format!("file://{}/nope.git", env.fx.root.display()),
        ],
    );
    assert_eq!(
        code(env.repos.fetch(
            env.id,
            FetchTarget::Remote {
                name: "missing".into()
            },
            false
        )),
        ErrorCode::RemoteNotFound
    );
}

#[test]
fn a_network_operation_can_be_cancelled() {
    let env = env();
    // The upload-pack command runs through a shell: a sleep stands in for a slow network.
    git_at(
        &env.fx.repo(),
        &[
            "config",
            "remote.origin.uploadpack",
            "sleep 10; git-upload-pack",
        ],
    );
    let repos = Arc::clone(&env.repos);
    let id = env.id;
    let handle = std::thread::spawn(move || {
        repos.fetch(
            id,
            FetchTarget::Remote {
                name: "origin".into(),
            },
            false,
        )
    });
    let started = env.sink.wait_for(
        Duration::from_secs(5),
        |e| matches!(e, BackendEvent::OpStarted(s) if s.kind == OpKind::Fetch && s.cancellable),
    );
    assert!(started);
    std::thread::sleep(Duration::from_millis(300));
    let op_id = env
        .sink
        .events()
        .iter()
        .find_map(|e| match e {
            BackendEvent::OpStarted(s) if s.kind == OpKind::Fetch => Some(s.op_id),
            _ => None,
        })
        .unwrap();
    let start = Instant::now();
    env.repos.cancel_op(op_id).unwrap();
    let result = handle.join().unwrap();
    assert_eq!(code(result), ErrorCode::Cancelled);
    assert!(
        start.elapsed() < Duration::from_secs(5),
        "{:?}",
        start.elapsed()
    );
}

fn set_prefs(env: &Env, change: impl FnOnce(&mut Preferences)) {
    let mut prefs = env.store.preferences().unwrap();
    change(&mut prefs);
    env.store.set_preferences(&prefs).unwrap();
}

#[test]
fn the_protected_branch_list_is_a_preference() {
    let env = env();
    git_at(
        &env.fx.repo(),
        &["commit", "-q", "--amend", "-m", "rewritten"],
    );
    let force = || PushRequest {
        force_with_lease: true,
        ..push_request()
    };
    assert_eq!(
        env.push(force()).unwrap_err().code,
        ErrorCode::ProtectedBranch
    );

    // `main` taken off the list: the same force push goes through, and the preview agrees.
    set_prefs(&env, |p| p.protected_branches = vec!["release/*".into()]);
    assert!(
        !env.repos
            .force_push_preview(env.id, None)
            .unwrap()
            .protected
    );
    env.push(force()).unwrap();
    assert_eq!(env.remote_rev("refs/heads/main"), env.rev("HEAD"));

    // A pattern added to the list protects a branch that was not protected.
    git_at(&env.fx.repo(), &["commit", "-q", "--amend", "-m", "again"]);
    set_prefs(&env, |p| {
        p.protected_branches = vec!["ma*".into(), "main".into()]
    });
    assert_eq!(
        env.push(force()).unwrap_err().code,
        ErrorCode::ProtectedBranch
    );
}

#[test]
fn the_pull_strategy_preference_overrides_the_git_config() {
    let env = env();
    git_at(&env.fx.repo(), &["config", "pull.rebase", "true"]);
    assert_eq!(
        env.repos.pull_default_strategy(env.id).unwrap(),
        PullStrategy::Rebase
    );
    set_prefs(&env, |p| p.pull_strategy = Some(PullStrategy::Merge));
    assert_eq!(
        env.repos.pull_default_strategy(env.id).unwrap(),
        PullStrategy::Merge
    );
    let theirs = env.teammate_pushes("t.txt");
    let mine = env.commit_in(&env.fx.repo(), "mine.txt", "mine\n");
    // A pull that names no strategy uses the preference: a merge commit, not a rebase.
    let result = env.repos.pull(env.id, None).unwrap();
    assert_eq!(result.strategy, PullStrategy::Merge);
    assert_eq!(env.rev("HEAD^1"), mine);
    assert_eq!(env.rev("HEAD^2"), theirs);

    // Back to "follow Git": the config applies again.
    set_prefs(&env, |p| p.pull_strategy = None);
    assert_eq!(
        env.repos.pull_default_strategy(env.id).unwrap(),
        PullStrategy::Rebase
    );
}

#[test]
fn an_explicit_pull_strategy_beats_the_preference() {
    let env = env();
    set_prefs(&env, |p| p.pull_strategy = Some(PullStrategy::Rebase));
    let theirs = env.teammate_pushes("t.txt");
    env.commit_in(&env.fx.repo(), "mine.txt", "mine\n");
    let result = env.repos.pull(env.id, Some(PullStrategy::Merge)).unwrap();
    assert_eq!(result.strategy, PullStrategy::Merge);
    assert_eq!(env.rev("HEAD^2"), theirs);
}

#[test]
fn a_protected_branch_is_never_deleted_on_the_remote() {
    let env = env();
    git_at(&env.fx.repo(), &["push", "-q", "origin", "main:release/2"]);
    git_at(&env.fx.repo(), &["fetch", "-q"]);
    for name in ["main", "release/2"] {
        let err = env
            .repos
            .delete_remote_branch(env.id, "origin", name)
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::ProtectedBranchDelete, "{name}");
        assert_eq!(
            env.remote_rev(&format!("refs/heads/{name}")),
            env.rev("HEAD")
        );
        assert_eq!(
            env.rev(&format!("refs/remotes/origin/{name}")),
            env.rev("HEAD")
        );
    }
    assert!(env.repos.op_history(env.id).unwrap().is_empty());
}
