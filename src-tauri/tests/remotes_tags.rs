//! Remote management and tag transfers (M4-7c) against local bare remotes reached through
//! `file://`: each test checks the resulting Git state.

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use common::{Fixture, RecordingSink};
use yaggui_lib::events::{BackendEvent, OpKind, OpOutcome};
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::errors::{ErrorCode, YagguiError};
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::ops::types::FetchTarget;
use yaggui_lib::repo::RepoManager;
use yaggui_lib::store::Store;

struct Env {
    fx: Fixture,
    sink: Arc<RecordingSink>,
    repos: Arc<RepoManager>,
    id: u32,
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

/// `git config --get`, `None` when unset.
fn config(dir: &Path, key: &str) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["config", "--get", key])
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    out.status
        .success()
        .then(|| String::from_utf8(out.stdout).unwrap().trim().to_owned())
}

fn env() -> Env {
    let fx = Fixture::new("clean");
    for dir in [fx.repo(), fx.root.join("origin.git")] {
        git_at(&dir, &["config", "user.name", "yaggui Tests"]);
        git_at(&dir, &["config", "user.email", "tests@yaggui.dev"]);
    }
    let url = format!("file://{}", fx.root.join("origin.git").display());
    fx.git(&["remote", "set-url", "origin", &url]);
    fx.git(&["fetch", "-q", "origin"]);
    fx.git(&["branch", "-q", "--set-upstream-to=origin/main", "main"]);
    // A second bare remote, for the management operations.
    git_at(&fx.root, &["init", "-q", "--bare", "mirror.git"]);
    let sink = Arc::new(RecordingSink::default());
    let git = GitCli::new(Arc::new(CommandLog::new()), sink.clone())
        .with_env("GIT_CONFIG_NOSYSTEM", "1")
        .with_env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        );
    let store = Arc::new(Store::open_in_memory().unwrap());
    let repos = Arc::new(
        RepoManager::new(Arc::new(git), store, sink.clone())
            .without_watcher()
            .with_backup_dir(fx.root.join("backups")),
    );
    let id = repos.open(&fx.repo_str()).unwrap().id;
    Env {
        fx,
        sink,
        repos,
        id,
    }
}

impl Env {
    fn repo(&self) -> PathBuf {
        self.fx.repo()
    }

    fn url(&self, bare: &str) -> String {
        format!("file://{}", self.fx.root.join(bare).display())
    }

    fn origin(&self) -> PathBuf {
        self.fx.root.join("origin.git")
    }

    fn rev(&self, dir: &Path, rev: &str) -> String {
        git_at(dir, &["rev-parse", "--verify", "-q", rev])
    }

    fn remotes(&self) -> Vec<String> {
        self.repos.remotes(self.id).unwrap()
    }
}

fn code<T: std::fmt::Debug>(result: Result<T, YagguiError>) -> ErrorCode {
    result.expect_err("expected an error").code
}

#[test]
fn remotes_are_added_with_separate_fetch_and_push_urls() {
    let env = env();
    let mirror = env.url("mirror.git");
    let push = env.url("origin.git");
    env.repos
        .add_remote(
            env.id,
            "mirror",
            &format!("  {mirror}\n"),
            Some(push.clone()),
        )
        .unwrap();
    assert_eq!(
        config(&env.repo(), "remote.mirror.url"),
        Some(mirror.clone())
    );
    assert_eq!(
        config(&env.repo(), "remote.mirror.pushurl"),
        Some(push.clone())
    );
    assert_eq!(
        config(&env.repo(), "remote.mirror.fetch"),
        Some("+refs/heads/*:refs/remotes/mirror/*".into())
    );
    assert!(env.sink.events().iter().any(|e| matches!(
        e,
        BackendEvent::OpFinished(f) if f.kind == OpKind::Remote && matches!(f.outcome, OpOutcome::Success { .. })
    )));
    let refs = env.repos.list_refs(env.id).unwrap();
    let listed = refs.remotes.iter().find(|r| r.name == "mirror").unwrap();
    assert_eq!(listed.push_url.as_deref(), Some(push.as_str()));
    assert_eq!(
        refs.remotes
            .iter()
            .find(|r| r.name == "origin")
            .unwrap()
            .push_url,
        None
    );

    assert_eq!(
        code(env.repos.add_remote(env.id, "mirror", &mirror, None)),
        ErrorCode::RemoteExists
    );
    assert_eq!(
        code(env.repos.validate_remote_name(env.id, "origin")),
        ErrorCode::RemoteExists
    );
    env.repos.validate_remote_name(env.id, "fork").unwrap();
    for name in ["", "-f", "a b", "a..b", "x:y"] {
        assert_eq!(
            code(env.repos.add_remote(env.id, name, &mirror, None)),
            ErrorCode::InvalidRemoteName,
            "{name:?}"
        );
    }
    for url in ["", "--upload-pack=touch pwned", "file:///a\nb"] {
        assert_eq!(
            code(env.repos.add_remote(env.id, "bad", url, None)),
            ErrorCode::InvalidArgument,
            "{url:?}"
        );
    }
    assert_eq!(env.remotes(), ["origin", "mirror"]);
}

#[test]
fn renaming_a_remote_moves_its_tracking_branches_and_upstreams() {
    let env = env();
    let main = env.rev(&env.repo(), "refs/remotes/origin/main");
    env.repos
        .rename_remote(env.id, "origin", "upstream")
        .unwrap();
    assert_eq!(env.remotes(), ["upstream"]);
    assert_eq!(env.rev(&env.repo(), "refs/remotes/upstream/main"), main);
    assert!(git_at(&env.repo(), &["branch", "-r", "--list", "origin/*"]).is_empty());
    assert_eq!(
        config(&env.repo(), "branch.main.remote"),
        Some("upstream".into())
    );

    git_at(
        &env.repo(),
        &["remote", "add", "mirror", &env.url("mirror.git")],
    );
    assert_eq!(
        code(env.repos.rename_remote(env.id, "upstream", "mirror")),
        ErrorCode::RemoteExists
    );
    assert_eq!(
        code(env.repos.rename_remote(env.id, "nope", "other")),
        ErrorCode::RemoteNotFound
    );
    assert_eq!(
        code(env.repos.rename_remote(env.id, "upstream", "bad name")),
        ErrorCode::InvalidRemoteName
    );
}

#[test]
fn fetch_and_push_urls_are_set_and_cleared() {
    let env = env();
    let mirror = env.url("mirror.git");
    let origin = env.url("origin.git");
    env.repos
        .set_remote_urls(env.id, "origin", &origin, Some(mirror.clone()))
        .unwrap();
    assert_eq!(
        config(&env.repo(), "remote.origin.pushurl"),
        Some(mirror.clone())
    );

    // Pushes now go to the push URL, fetches still read the fetch URL.
    git_at(&env.repo(), &["tag", "v1"]);
    env.repos.push_tag(env.id, "origin", "v1").unwrap();
    let mirror_dir = env.fx.root.join("mirror.git");
    assert_eq!(
        env.rev(&mirror_dir, "refs/tags/v1"),
        env.rev(&env.repo(), "HEAD")
    );
    assert!(git_at(&env.origin(), &["tag", "-l", "v1"]).is_empty());

    env.repos
        .set_remote_urls(env.id, "origin", &mirror, None)
        .unwrap();
    assert_eq!(
        config(&env.repo(), "remote.origin.url"),
        Some(mirror.clone())
    );
    assert_eq!(config(&env.repo(), "remote.origin.pushurl"), None);
    // Clearing an unset push URL is not an error.
    env.repos
        .set_remote_urls(env.id, "origin", &origin, None)
        .unwrap();
    assert_eq!(config(&env.repo(), "remote.origin.url"), Some(origin));
    assert_eq!(
        code(
            env.repos
                .set_remote_urls(env.id, "origin", "-oProxyCommand=x", None)
        ),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        code(env.repos.set_remote_urls(env.id, "nope", &mirror, None)),
        ErrorCode::RemoteNotFound
    );
}

#[test]
fn removing_a_remote_drops_its_tracking_branches_after_a_preview() {
    let env = env();
    git_at(&env.repo(), &["push", "-q", "origin", "main:feat/x"]);
    git_at(&env.repo(), &["fetch", "-q", "origin"]);
    git_at(
        &env.repo(),
        &["branch", "-q", "other", "--track", "origin/feat/x"],
    );

    let preview = env.repos.remote_removal_preview(env.id, "origin").unwrap();
    assert_eq!(preview.tracking, ["origin/feat/x", "origin/main"]);
    assert_eq!(preview.upstream_of, ["main", "other"]);
    assert_eq!(
        code(env.repos.remote_removal_preview(env.id, "nope")),
        ErrorCode::RemoteNotFound
    );

    let sha = env.rev(&env.repo(), "refs/remotes/origin/main");
    let removed = env.repos.remove_remote(env.id, "origin").unwrap();
    assert_eq!(removed.name, "origin");
    assert_eq!(removed.url, Some(env.url("origin.git")));
    assert_eq!(removed.push_url, None);
    assert_eq!(removed.tracking.len(), 2);
    assert!(
        removed
            .tracking
            .iter()
            .any(|r| r.full_name == "refs/remotes/origin/main" && r.sha == sha)
    );
    assert!(env.remotes().is_empty());
    assert!(git_at(&env.repo(), &["branch", "-r"]).is_empty());
    assert_eq!(config(&env.repo(), "branch.main.remote"), None);
    assert_eq!(
        code(env.repos.remove_remote(env.id, "origin")),
        ErrorCode::RemoteNotFound
    );
}

#[test]
fn all_tags_are_pushed_and_refused_ones_are_reported() {
    let env = env();
    git_at(&env.repo(), &["tag", "v1"]);
    git_at(&env.repo(), &["tag", "-a", "v2", "-m", "release 2"]);
    let result = env.repos.push_all_tags(env.id, "origin").unwrap();
    assert_eq!(result.pushed, ["v1", "v2"]);
    assert_eq!(result.up_to_date, 0);
    assert_eq!(
        env.rev(&env.origin(), "refs/tags/v2"),
        env.rev(&env.repo(), "refs/tags/v2")
    );
    // Only tags: the branches are left alone.
    assert!(git_at(&env.origin(), &["branch", "--list", "feat"]).is_empty());

    let again = env.repos.push_all_tags(env.id, "origin").unwrap();
    assert!(again.pushed.is_empty());
    assert_eq!(again.up_to_date, 2);

    // The remote has another v1: refused, without force; v3 still goes.
    std::fs::write(env.repo().join("n.txt"), "n\n").unwrap();
    git_at(&env.repo(), &["add", "n.txt"]);
    git_at(&env.repo(), &["commit", "-q", "-m", "next"]);
    git_at(&env.repo(), &["tag", "-f", "v1"]);
    git_at(&env.repo(), &["tag", "v3"]);
    let refused = env.repos.push_all_tags(env.id, "origin").unwrap_err();
    assert_eq!(refused.code, ErrorCode::TagRejected);
    assert!(refused.message.en.contains("v1"), "{}", refused.message.en);
    assert!(refused.message.fr.contains("existe déjà"));
    assert_ne!(
        env.rev(&env.origin(), "refs/tags/v1"),
        env.rev(&env.repo(), "refs/tags/v1")
    );
    assert_eq!(
        env.rev(&env.origin(), "refs/tags/v3"),
        env.rev(&env.repo(), "refs/tags/v3")
    );
    assert_eq!(
        code(env.repos.push_tag(env.id, "origin", "v1")),
        ErrorCode::TagRejected
    );
    assert_eq!(
        code(env.repos.push_all_tags(env.id, "nope")),
        ErrorCode::RemoteNotFound
    );
}

#[test]
fn tags_are_fetched_even_off_the_fetched_branches() {
    let env = env();
    // A teammate tags a commit that no branch of the remote reaches.
    let other = env.fx.root.join("other");
    git_at(
        &env.fx.root,
        &["clone", "-q", &env.url("origin.git"), "other"],
    );
    git_at(&other, &["config", "user.name", "Other"]);
    git_at(&other, &["config", "user.email", "o@yaggui.dev"]);
    git_at(&other, &["checkout", "-q", "--detach"]);
    std::fs::write(other.join("t.txt"), "t\n").unwrap();
    git_at(&other, &["add", "t.txt"]);
    git_at(&other, &["commit", "-q", "-m", "tagged only"]);
    git_at(&other, &["tag", "-a", "hotfix", "-m", "hotfix"]);
    git_at(&other, &["push", "-q", "origin", "refs/tags/hotfix"]);

    env.repos.fetch(env.id, FetchTarget::All, false).unwrap();
    assert!(git_at(&env.repo(), &["tag", "-l", "hotfix"]).is_empty());

    env.repos
        .fetch_tags(
            env.id,
            FetchTarget::Remote {
                name: "origin".into(),
            },
        )
        .unwrap();
    assert_eq!(
        env.rev(&env.repo(), "refs/tags/hotfix"),
        env.rev(&other, "refs/tags/hotfix")
    );
    assert!(env.sink.events().iter().any(|e| matches!(
        e,
        BackendEvent::OpStarted(s) if s.kind == OpKind::Fetch && s.cancellable
    )));
    env.repos.fetch_tags(env.id, FetchTarget::All).unwrap();
    assert_eq!(
        code(env.repos.fetch_tags(
            env.id,
            FetchTarget::Remote {
                name: "nope".into()
            }
        )),
        ErrorCode::RemoteNotFound
    );
}

#[test]
fn deleting_a_tag_already_gone_on_the_remote_succeeds() {
    let env = env();
    git_at(&env.repo(), &["tag", "v9"]);
    env.repos.push_tag(env.id, "origin", "v9").unwrap();
    env.repos.delete_remote_tag(env.id, "origin", "v9").unwrap();
    assert!(git_at(&env.origin(), &["tag", "-l", "v9"]).is_empty());
    env.repos.delete_remote_tag(env.id, "origin", "v9").unwrap();
    // The local tag is untouched.
    assert_eq!(git_at(&env.repo(), &["tag", "-l", "v9"]), "v9");
}

#[test]
fn remote_operations_are_undone_and_redone() {
    let env = env();
    let mirror = env.url("mirror.git");
    env.repos
        .add_remote(env.id, "mirror", &mirror, Some(env.url("origin.git")))
        .unwrap();
    env.repos.undo(env.id).unwrap();
    assert_eq!(env.remotes(), ["origin"]);
    env.repos.redo(env.id).unwrap();
    assert_eq!(env.remotes(), ["origin", "mirror"]);
    assert_eq!(
        config(&env.repo(), "remote.mirror.pushurl"),
        Some(env.url("origin.git"))
    );

    env.repos.rename_remote(env.id, "mirror", "backup").unwrap();
    env.repos.undo(env.id).unwrap();
    assert_eq!(env.remotes(), ["origin", "mirror"]);
    env.repos.redo(env.id).unwrap();
    assert_eq!(env.remotes(), ["origin", "backup"]);

    // A removal comes back with its tracking branches, refspec and upstreams.
    git_at(
        &env.repo(),
        &[
            "config",
            "--add",
            "remote.origin.fetch",
            "+refs/notes/*:refs/notes/*",
        ],
    );
    let main = env.rev(&env.repo(), "refs/remotes/origin/main");
    env.repos.remove_remote(env.id, "origin").unwrap();
    env.repos.undo(env.id).unwrap();
    assert_eq!(env.rev(&env.repo(), "refs/remotes/origin/main"), main);
    assert_eq!(
        config(&env.repo(), "branch.main.remote"),
        Some("origin".into())
    );
    assert_eq!(
        config(&env.repo(), "branch.main.merge"),
        Some("refs/heads/main".into())
    );
    assert_eq!(
        git_at(&env.repo(), &["config", "--get-all", "remote.origin.fetch"]),
        "+refs/heads/*:refs/remotes/origin/*\n+refs/notes/*:refs/notes/*"
    );
    assert_eq!(
        config(&env.repo(), "remote.origin.url"),
        Some(env.url("origin.git"))
    );
    env.repos.redo(env.id).unwrap();
    assert!(!env.remotes().contains(&"origin".to_owned()));

    // Changed elsewhere since: refused rather than guessed.
    git_at(&env.repo(), &["remote", "add", "origin", &mirror]);
    assert_eq!(code(env.repos.undo(env.id)), ErrorCode::UndoDiverged);
}

#[test]
fn local_tags_are_undone_and_pushes_are_not() {
    let env = env();
    let head = env.rev(&env.repo(), "HEAD");
    env.repos
        .create_tag(
            env.id,
            yaggui_lib::git::ops::types::CreateTagRequest {
                name: "v5".into(),
                target: head.clone(),
                message: Some("five".into()),
                sign: false,
            },
        )
        .unwrap();
    let object = env.rev(&env.repo(), "refs/tags/v5");
    env.repos.undo(env.id).unwrap();
    assert!(git_at(&env.repo(), &["tag", "-l", "v5"]).is_empty());
    env.repos.redo(env.id).unwrap();
    // The annotated tag object itself comes back.
    assert_eq!(env.rev(&env.repo(), "refs/tags/v5"), object);

    env.repos.delete_tag(env.id, "v5").unwrap();
    env.repos.undo(env.id).unwrap();
    assert_eq!(env.rev(&env.repo(), "refs/tags/v5"), object);

    env.repos.push_all_tags(env.id, "origin").unwrap();
    assert_eq!(code(env.repos.undo(env.id)), ErrorCode::UndoBlocked);
}

fn tag_names(tags: &[yaggui_lib::git::read::remote_tags::RemoteTag]) -> Vec<(String, Vec<String>)> {
    tags.iter()
        .map(|t| (t.name.clone(), t.remotes.clone()))
        .collect()
}

#[test]
fn remote_tags_match_local_tags_by_object_and_refresh_on_demand() {
    let env = env();
    env.fx.git(&["tag", "v-light"]);
    env.fx.git(&["tag", "-a", "-m", "annotated", "v-ann"]);
    env.repos.push_tag(env.id, "origin", "v-ann").unwrap();
    // On the remote under a local tag's name, but at another commit.
    git_at(&env.origin(), &["tag", "v-other", "main~1"]);
    env.fx.git(&["tag", "v-other"]);
    // A remote that cannot be reached is skipped, not an error.
    env.fx
        .git(&["remote", "add", "gone", &env.url("missing.git")]);

    let o = || vec!["origin".to_owned()];
    // The first request lists the remotes even without `refresh`.
    let tags = env.repos.remote_tags(env.id, false).unwrap();
    assert_eq!(tag_names(&tags), [("v-ann".into(), o())]);

    // Pushed outside yaggui: seen once listed again.
    env.fx.git(&["push", "-q", "origin", "refs/tags/v-light"]);
    let cached = env.repos.remote_tags(env.id, false).unwrap();
    assert_eq!(tag_names(&cached), [("v-ann".into(), o())]);
    let tags = env.repos.remote_tags(env.id, true).unwrap();
    assert_eq!(
        tag_names(&tags),
        [("v-ann".into(), o()), ("v-light".into(), o())]
    );

    // Local changes need no listing: the last one is compared with the current tags.
    env.fx.git(&["tag", "-d", "v-light"]);
    let tags = env.repos.remote_tags(env.id, false).unwrap();
    assert_eq!(tag_names(&tags), [("v-ann".into(), o())]);

    let ls_remotes = env
        .sink
        .events()
        .iter()
        .filter(|e| {
            matches!(e, BackendEvent::CommandLogged(c) if c.entry.args.first().is_some_and(|a| a == "ls-remote"))
        })
        .count();
    // Two listings of two remotes.
    assert_eq!(ls_remotes, 4);
}
