//! Merge, rebase, cherry-pick, revert, reset, the operation in progress and conflicts (M3-1)
//! on temporary repositories: each test checks the resulting Git state.

mod common;

use std::sync::Arc;

use common::{Fixture, RecordingSink};
use yaggui_lib::events::{BackendEvent, OpKind};
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::errors::{ErrorCode, ErrorPayload, YagguiError};
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::ops::types::{
    CherryPickRequest, ConflictKind, ConflictResolution, ConflictStage, FastForwardRequest,
    HistoryEffect, LostChange, MergeMode, MergeRequest, RebaseRequest, ResetMode, ResetRequest,
    RevertRequest, RevisionRelation,
};
use yaggui_lib::git::read::state::RepoOperation;
use yaggui_lib::repo::RepoManager;
use yaggui_lib::store::Store;

struct Env {
    fx: Fixture,
    sink: Arc<RecordingSink>,
    repos: Arc<RepoManager>,
    id: u32,
}

/// A `clean` fixture (`README.md`, `src.txt` on main) opened by an isolated backend.
fn env() -> Env {
    let fx = Fixture::new("clean");
    fx.git(&["config", "user.name", "yaggui Tests"]);
    fx.git(&["config", "user.email", "tests@yaggui.dev"]);
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
    fn path(&self, path: &str) -> std::path::PathBuf {
        self.fx.repo().join(path)
    }

    fn write(&self, path: &str, content: &str) {
        let full = self.path(path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(full, content).unwrap();
    }

    fn read(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(self.path(path)).ok()
    }

    fn out(&self, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(self.fx.repo())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        String::from_utf8(out.stdout).unwrap().trim().to_owned()
    }

    fn rev(&self, rev: &str) -> String {
        self.out(&["rev-parse", "--verify", "-q", rev])
    }

    fn head_branch(&self) -> String {
        self.out(&["symbolic-ref", "-q", "--short", "HEAD"])
    }

    fn parents(&self, rev: &str) -> usize {
        self.out(&["rev-list", "--parents", "-n", "1", rev])
            .split_whitespace()
            .count()
            - 1
    }

    fn subject(&self, rev: &str) -> String {
        self.out(&["log", "-1", "--format=%s", rev])
    }

    fn status(&self) -> String {
        self.out(&["status", "--porcelain=v1", "--untracked-files=all"])
    }

    fn commit(&self, path: &str, content: &str, message: &str) {
        self.write(path, content);
        self.fx.git(&["add", "-A", "--", path]);
        self.fx.git(&["commit", "-q", "-m", message]);
    }

    fn remove(&self, path: &str, message: &str) {
        self.fx.git(&["rm", "-q", "--", path]);
        self.fx.git(&["commit", "-q", "-m", message]);
    }

    /// `other` from main changes `src.txt`, main changes it too: a content conflict.
    fn diverge_on_src(&self) {
        self.fx.git(&["switch", "-q", "-c", "other"]);
        self.commit("src.txt", "other\n", "other changes src");
        self.fx.git(&["switch", "-q", "main"]);
        self.commit("src.txt", "main\n", "main changes src");
    }

    fn operation(&self) -> Option<RepoOperation> {
        self.repos.state(self.id).unwrap().operation
    }

    fn merge(
        &self,
        source: &str,
        mode: MergeMode,
    ) -> Result<yaggui_lib::git::ops::types::HistoryResult, YagguiError> {
        self.repos.merge(
            self.id,
            MergeRequest {
                source: source.into(),
                mode,
                message: None,
            },
        )
    }

    fn resolve(&self, paths: &[&str], resolution: ConflictResolution) {
        self.repos
            .resolve_conflicts(
                self.id,
                paths.iter().map(|p| (*p).to_owned()).collect(),
                resolution,
            )
            .unwrap();
    }
}

fn fails<T: std::fmt::Debug>(result: Result<T, YagguiError>) -> (ErrorCode, YagguiError) {
    let err = result.expect_err("expected an error");
    (err.code, err)
}

fn conflict_paths(err: &YagguiError) -> Vec<String> {
    match err.payload.as_deref() {
        Some(ErrorPayload::Conflicts { paths, .. }) => paths.clone(),
        other => panic!("expected a conflicts payload, got {other:?}"),
    }
}

// --- Merge ------------------------------------------------------------------------------

#[test]
fn merge_fast_forwards_or_creates_a_merge_commit() {
    let env = env();
    env.fx.git(&["switch", "-q", "-c", "ahead"]);
    env.commit("a.txt", "a\n", "ahead 1");
    env.fx.git(&["switch", "-q", "main"]);
    let main = env.rev("main");

    // `fastForwardOnly` and `fastForward` move the branch without a commit.
    let result = env.merge("ahead", MergeMode::FastForwardOnly).unwrap();
    assert_eq!(result.effect, HistoryEffect::FastForward);
    assert_eq!(result.head, env.rev("ahead"));
    assert_eq!(result.previous_head.as_deref(), Some(main.as_str()));
    assert_eq!(env.rev("main"), env.rev("ahead"));

    // Already merged: nothing to do.
    let again = env.merge("ahead", MergeMode::NoFastForward).unwrap();
    assert_eq!(again.effect, HistoryEffect::UpToDate);

    // `noFastForward` always creates a merge commit, with the given message.
    env.fx.git(&["reset", "-q", "--hard", &main]);
    let result = env
        .repos
        .merge(
            env.id,
            MergeRequest {
                source: "ahead".into(),
                mode: MergeMode::NoFastForward,
                message: Some("Merge ahead, on purpose".into()),
            },
        )
        .unwrap();
    assert_eq!(result.effect, HistoryEffect::Commits);
    assert_eq!(env.parents("HEAD"), 2);
    assert_eq!(env.subject("HEAD"), "Merge ahead, on purpose");
    assert_eq!(env.status(), "");
}

#[test]
fn merge_ff_only_refuses_diverged_branches() {
    let env = env();
    env.diverge_on_src();
    let before = env.rev("HEAD");
    let (code, err) = fails(env.merge("other", MergeMode::FastForwardOnly));
    assert_eq!(code, ErrorCode::NotFastForward, "{err:?}");
    assert!(err.message.en.contains("other"));
    assert_eq!(env.rev("HEAD"), before);
    assert_eq!(env.operation(), None);
}

fn ff_request(branch: &str, to: &str) -> FastForwardRequest {
    FastForwardRequest {
        branch: branch.into(),
        to: to.into(),
    }
}

#[test]
fn revision_relation_says_which_side_can_fast_forward() {
    let env = env();
    env.fx.git(&["switch", "-q", "-c", "ahead"]);
    env.commit("a.txt", "a\n", "ahead 1");
    env.fx.git(&["switch", "-q", "main"]);
    let relation = |a: &str, b: &str| env.repos.revision_relation(env.id, a, b).unwrap();
    assert_eq!(relation("main", "main"), RevisionRelation::Same);
    assert_eq!(relation("main", "ahead"), RevisionRelation::Behind);
    assert_eq!(relation("ahead", "main"), RevisionRelation::Ahead);
    env.commit("m.txt", "m\n", "main 1");
    assert_eq!(relation("main", "ahead"), RevisionRelation::Diverged);
    let (code, _) = fails(env.repos.revision_relation(env.id, "main", "--all"));
    assert_eq!(code, ErrorCode::RevisionNotFound);
}

#[test]
fn fast_forward_moves_a_branch_that_is_not_checked_out() {
    let env = env();
    let main = env.rev("main");
    env.fx.git(&["branch", "develop"]);
    env.fx.git(&["switch", "-q", "-c", "feat"]);
    env.commit("f.txt", "f\n", "feat 1");
    env.write("local.txt", "uncommitted\n");
    let feat = env.rev("feat");

    let result = env
        .repos
        .fast_forward(env.id, ff_request("develop", "feat"))
        .unwrap();
    assert!(!result.up_to_date);
    assert_eq!(result.previous, main);
    assert_eq!(result.sha, feat);
    assert_eq!(env.rev("develop"), feat);
    // No checkout: HEAD, the working tree and the tracking config stay as they were.
    assert_eq!(env.out(&["symbolic-ref", "--short", "HEAD"]), "feat");
    assert_eq!(env.read("local.txt").as_deref(), Some("uncommitted\n"));
    assert_eq!(
        env.out(&["config", "--get", "branch.develop.merge"]),
        "",
        "no upstream set up"
    );

    // Undone like a ref move: develop goes back, the working tree is untouched.
    env.repos.undo(env.id).unwrap();
    assert_eq!(env.rev("develop"), main);
    assert_eq!(env.read("local.txt").as_deref(), Some("uncommitted\n"));

    // A branch that already contains the target does not move, and journals nothing.
    let again = env
        .repos
        .fast_forward(env.id, ff_request("feat", "develop"))
        .unwrap();
    assert!(again.up_to_date);
    assert_eq!(env.rev("feat"), feat);
}

#[test]
fn fast_forward_of_the_checked_out_branch_moves_the_working_tree() {
    let env = env();
    env.fx.git(&["switch", "-q", "-c", "ahead"]);
    env.commit("a.txt", "a\n", "ahead 1");
    env.fx.git(&["switch", "-q", "main"]);
    let main = env.rev("main");

    let result = env
        .repos
        .fast_forward(env.id, ff_request("main", "ahead"))
        .unwrap();
    assert!(!result.up_to_date);
    assert_eq!(env.rev("main"), env.rev("ahead"));
    assert_eq!(env.read("a.txt").as_deref(), Some("a\n"));
    assert_eq!(env.status(), "");

    env.repos.undo(env.id).unwrap();
    assert_eq!(env.rev("main"), main);
    assert_eq!(env.read("a.txt"), None);
}

#[test]
fn fast_forward_refuses_diverged_branches_another_worktree_and_an_operation_in_progress() {
    let env = env();
    env.diverge_on_src();
    let other = env.rev("other");
    let (code, err) = fails(env.repos.fast_forward(env.id, ff_request("other", "main")));
    assert_eq!(code, ErrorCode::NotFastForward, "{err:?}");
    assert_eq!(env.rev("other"), other);

    env.fx.git(&["branch", "behind", "main~1"]);
    let worktree = env.fx.root.join("wt-behind");
    env.fx.git(&[
        "worktree",
        "add",
        "-q",
        worktree.to_str().unwrap(),
        "behind",
    ]);
    let behind = env.rev("behind");
    let (code, err) = fails(env.repos.fast_forward(env.id, ff_request("behind", "main")));
    assert_eq!(code, ErrorCode::BranchInOtherWorktree, "{err:?}");
    assert_eq!(env.rev("behind"), behind);

    // An operation in progress blocks it even for a branch that is not checked out.
    env.fx.git(&["branch", "late", "main~1"]);
    let late = env.rev("late");
    let (code, _) = fails(env.merge("other", MergeMode::NoFastForward));
    assert_eq!(code, ErrorCode::Conflicts);
    let (code, err) = fails(env.repos.fast_forward(env.id, ff_request("late", "main")));
    assert_eq!(code, ErrorCode::OperationInProgress, "{err:?}");
    assert_eq!(env.rev("late"), late);
}

#[test]
fn merge_default_message_names_the_branch_and_squash_makes_one_commit() {
    let env = env();
    env.fx.git(&["switch", "-q", "-c", "feat"]);
    env.commit("f1.txt", "1\n", "feat 1");
    env.commit("f2.txt", "2\n", "feat 2");
    env.fx.git(&["switch", "-q", "main"]);
    env.commit("m.txt", "m\n", "main 1");
    let main = env.rev("main");

    env.merge("feat", MergeMode::FastForward).unwrap();
    assert_eq!(env.subject("HEAD"), "Merge branch 'feat'");
    assert_eq!(env.parents("HEAD"), 2);

    env.fx.git(&["reset", "-q", "--hard", &main]);
    let result = env.merge("feat", MergeMode::Squash).unwrap();
    assert_eq!(result.effect, HistoryEffect::Commits);
    assert_eq!(env.parents("HEAD"), 1);
    assert_eq!(env.rev("HEAD~1"), main);
    assert!(env.read("f1.txt").is_some() && env.read("f2.txt").is_some());
    assert!(env.subject("HEAD").starts_with("Squashed commit"));
    assert_eq!(env.operation(), None, "no squash left pending");
}

#[test]
fn merge_stops_on_conflicts_then_continues_with_the_given_message() {
    let env = env();
    env.diverge_on_src();
    let main = env.rev("main");

    let (code, err) = fails(env.merge("other", MergeMode::FastForward));
    assert_eq!(code, ErrorCode::Conflicts, "{err:?}");
    assert_eq!(conflict_paths(&err), ["src.txt"]);
    assert_eq!(
        env.operation(),
        Some(RepoOperation::Merge { squash: false })
    );

    let detail = env.repos.operation_detail(env.id).unwrap().unwrap();
    assert_eq!(detail.unresolved, 1);
    assert!(!detail.can_continue && !detail.can_skip);
    assert_eq!(detail.message.as_deref(), Some("Merge branch 'other'"));
    assert_eq!(detail.labels.ours.branch.as_deref(), Some("main"));
    assert_eq!(detail.labels.theirs.branch.as_deref(), Some("other"));
    assert_eq!(
        detail
            .labels
            .theirs
            .commit
            .as_ref()
            .map(|c| c.summary.as_str()),
        Some("other changes src")
    );

    let versions = env.repos.conflict_versions(env.id, "src.txt").unwrap();
    assert_eq!(versions.kind, Some(ConflictKind::Content));
    assert_eq!(versions.base.unwrap().text.as_deref(), Some("line 1\n"));
    assert_eq!(versions.ours.unwrap().text.as_deref(), Some("main\n"));
    assert_eq!(versions.theirs.unwrap().text.as_deref(), Some("other\n"));
    assert!(
        versions
            .merged
            .unwrap()
            .text
            .unwrap()
            .contains("<<<<<<< HEAD")
    );

    let (code, _) = fails(env.repos.continue_operation(env.id, None));
    assert_eq!(code, ErrorCode::UnresolvedConflicts);

    env.resolve(&["src.txt"], ConflictResolution::Theirs);
    let list = env.repos.list_conflicts(env.id).unwrap();
    assert_eq!(list.unresolved, 0);
    assert_eq!(list.files.len(), 1, "the resolved file stays listed");
    assert!(list.files[0].resolved && list.files[0].kind.is_none());
    assert!(
        env.repos
            .operation_detail(env.id)
            .unwrap()
            .unwrap()
            .can_continue
    );

    let result = env
        .repos
        .continue_operation(env.id, Some("Merge other, keeping theirs".into()))
        .unwrap();
    assert_eq!(result.effect, HistoryEffect::Commits);
    assert_eq!(result.previous_head.as_deref(), Some(main.as_str()));
    assert_eq!(env.parents("HEAD"), 2);
    assert_eq!(env.subject("HEAD"), "Merge other, keeping theirs");
    assert_eq!(env.read("src.txt").as_deref(), Some("other\n"));
    assert_eq!(env.operation(), None);
    assert!(env.repos.list_conflicts(env.id).unwrap().files.is_empty());

    let (code, _) = fails(env.repos.continue_operation(env.id, None));
    assert_eq!(code, ErrorCode::NoOperation);
}

#[test]
fn merge_continue_keeps_git_message_and_abort_restores() {
    let env = env();
    env.diverge_on_src();
    let main = env.rev("main");
    fails(env.merge("other", MergeMode::NoFastForward));
    let (code, _) = fails(env.merge("other", MergeMode::NoFastForward));
    assert_eq!(code, ErrorCode::OperationInProgress);

    env.repos.abort_operation(env.id).unwrap();
    assert_eq!(env.operation(), None);
    assert_eq!(env.rev("HEAD"), main);
    assert_eq!(env.read("src.txt").as_deref(), Some("main\n"));
    assert_eq!(env.status(), "");

    fails(env.merge("other", MergeMode::NoFastForward));
    env.write("src.txt", "both\n");
    env.resolve(&["src.txt"], ConflictResolution::MarkResolved);
    env.repos.continue_operation(env.id, None).unwrap();
    assert_eq!(env.subject("HEAD"), "Merge branch 'other'");
    let body = env.out(&["log", "-1", "--format=%B"]);
    assert!(
        !body.contains("Conflicts"),
        "comment lines are dropped: {body}"
    );
}

#[test]
fn merge_refuses_local_changes_it_would_overwrite() {
    let env = env();
    env.diverge_on_src();
    env.write("src.txt", "local edit\n");
    let (code, err) = fails(env.merge("other", MergeMode::FastForward));
    assert_eq!(code, ErrorCode::DirtyWorktree, "{err:?}");
    match err.payload.as_deref() {
        Some(ErrorPayload::DirtyWorktree { paths, can_carry }) => {
            assert_eq!(paths, &["src.txt"]);
            assert!(!can_carry);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(env.read("src.txt").as_deref(), Some("local edit\n"));
    assert_eq!(env.operation(), None);
}

#[test]
fn squash_merge_conflict_is_an_operation_in_progress() {
    let env = env();
    env.diverge_on_src();
    let main = env.rev("main");
    let (code, _) = fails(env.merge("other", MergeMode::Squash));
    assert_eq!(code, ErrorCode::Conflicts);
    assert_eq!(env.operation(), Some(RepoOperation::Merge { squash: true }));
    let detail = env.repos.operation_detail(env.id).unwrap().unwrap();
    assert_eq!(
        detail
            .labels
            .theirs
            .commit
            .as_ref()
            .map(|c| c.summary.as_str()),
        Some("other changes src")
    );
    assert!(detail.message.unwrap().starts_with("Squashed commit"));

    env.resolve(&["src.txt"], ConflictResolution::Theirs);
    env.repos
        .continue_operation(env.id, Some("Squash other".into()))
        .unwrap();
    assert_eq!(env.parents("HEAD"), 1);
    assert_eq!(env.rev("HEAD~1"), main);
    assert_eq!(env.subject("HEAD"), "Squash other");
    assert_eq!(env.operation(), None);

    // Abort of a squash: back to HEAD.
    env.fx.git(&["reset", "-q", "--hard", &main]);
    fails(env.merge("other", MergeMode::Squash));
    env.repos.abort_operation(env.id).unwrap();
    assert_eq!(env.operation(), None);
    assert_eq!(env.status(), "");
    assert_eq!(env.rev("HEAD"), main);
}

// --- Conflict kinds ---------------------------------------------------------------------

#[test]
fn conflict_list_is_typed_and_each_kind_resolves() {
    let env = env();
    env.commit("gone-theirs.txt", "base\n", "add gone-theirs");
    env.commit("gone-ours.txt", "base\n", "add gone-ours");
    env.commit("logo.bin", "\u{0}base", "add binary");
    env.fx.git(&["switch", "-q", "-c", "other"]);
    env.remove("gone-theirs.txt", "other deletes");
    env.commit("gone-ours.txt", "theirs edit\n", "other edits");
    env.commit("both.txt", "theirs\n", "other adds both");
    env.commit("logo.bin", "\u{0}theirs", "other binary");
    env.fx.git(&["switch", "-q", "main"]);
    env.commit("gone-theirs.txt", "ours edit\n", "main edits");
    env.remove("gone-ours.txt", "main deletes");
    env.commit("both.txt", "ours\n", "main adds both");
    env.commit("logo.bin", "\u{0}ours", "main binary");

    let (code, err) = fails(env.merge("other", MergeMode::NoFastForward));
    assert_eq!(code, ErrorCode::Conflicts, "{err:?}");
    let list = env.repos.list_conflicts(env.id).unwrap();
    let kinds: Vec<_> = list
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.kind, f.binary))
        .collect();
    assert_eq!(
        kinds,
        [
            ("both.txt", Some(ConflictKind::BothAdded), false),
            ("gone-ours.txt", Some(ConflictKind::DeletedByUs), false),
            ("gone-theirs.txt", Some(ConflictKind::DeletedByThem), false),
            ("logo.bin", Some(ConflictKind::Content), true),
        ]
    );
    assert_eq!(list.unresolved, 4);
    let binary = env.repos.conflict_versions(env.id, "logo.bin").unwrap();
    assert!(binary.ours.as_ref().unwrap().binary && binary.ours.unwrap().text.is_none());
    let deleted = env
        .repos
        .conflict_versions(env.id, "gone-ours.txt")
        .unwrap();
    assert!(deleted.ours.is_none() && deleted.base.is_some() && deleted.theirs.is_some());

    // Ours on "deleted by us" deletes; theirs on "deleted by them" deletes too.
    env.resolve(&["gone-ours.txt"], ConflictResolution::Ours);
    assert!(env.read("gone-ours.txt").is_none());
    env.resolve(&["gone-theirs.txt"], ConflictResolution::Theirs);
    assert!(env.read("gone-theirs.txt").is_none());
    env.resolve(&["logo.bin"], ConflictResolution::Theirs);
    assert_eq!(env.read("logo.bin").as_deref(), Some("\u{0}theirs"));
    env.resolve(
        &["both.txt"],
        ConflictResolution::Content {
            content: "ours and theirs\n".into(),
        },
    );
    assert_eq!(env.read("both.txt").as_deref(), Some("ours and theirs\n"));

    let err = env
        .repos
        .resolve_conflicts(env.id, vec!["README.md".into()], ConflictResolution::Ours)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);

    let list = env.repos.list_conflicts(env.id).unwrap();
    assert_eq!(list.unresolved, 0);
    assert!(list.files.iter().all(|f| f.resolved));
    env.repos.continue_operation(env.id, None).unwrap();
    let tree = env.out(&["ls-tree", "--name-only", "HEAD"]);
    assert!(!tree.contains("gone-ours.txt") && !tree.contains("gone-theirs.txt"));
    assert_eq!(env.out(&["show", "HEAD:both.txt"]), "ours and theirs");
}

// --- Rebase -----------------------------------------------------------------------------

/// `feature` (2 commits, the first editing `src.txt`) from main; main edits `src.txt` too.
fn rebase_env(conflict: bool) -> Env {
    let env = env();
    env.fx.git(&["switch", "-q", "-c", "feature"]);
    env.commit("src.txt", "feature\n", "feature: edit src");
    env.commit("feature.txt", "more\n", "feature: add file");
    env.fx.git(&["switch", "-q", "main"]);
    if conflict {
        env.commit("src.txt", "main\n", "main: edit src");
    } else {
        env.commit("main.txt", "main\n", "main: add file");
    }
    env
}

#[test]
fn rebase_replays_a_branch_with_progress() {
    let env = rebase_env(false);
    let feature = env.rev("feature");
    env.fx.git(&["switch", "-q", "feature"]);
    env.sink.clear();
    let result = env
        .repos
        .rebase(
            env.id,
            RebaseRequest {
                branch: None,
                onto: "main".into(),
            },
        )
        .unwrap();
    assert_eq!(result.effect, HistoryEffect::Commits);
    assert_eq!(result.previous_head.as_deref(), Some(feature.as_str()));
    assert_eq!(env.head_branch(), "feature");
    assert_eq!(env.rev("feature~2"), env.rev("main"));
    assert_eq!(env.parents("feature"), 1);
    let steps: Vec<_> = env
        .sink
        .events()
        .into_iter()
        .filter_map(|e| match e {
            BackendEvent::OpProgress(p) if p.phase == "Rebasing" => Some((p.current, p.total)),
            _ => None,
        })
        .collect();
    // Seen once on Windows CI with only (1, 2): show what Git wrote if it happens again.
    let stderr: Vec<_> = env
        .sink
        .events()
        .into_iter()
        .filter_map(|e| match e {
            BackendEvent::CommandLogged(c)
                if c.entry.args.first().is_some_and(|a| a == "rebase") =>
            {
                Some(c.entry.stderr)
            }
            _ => None,
        })
        .collect();
    assert!(
        steps.contains(&(Some(2), Some(2))),
        "{steps:?}, rebase stderr: {stderr:?}"
    );
}

#[test]
fn rebase_checks_out_the_given_branch_and_reports_up_to_date() {
    let env = rebase_env(false);
    env.repos
        .rebase(
            env.id,
            RebaseRequest {
                branch: Some("feature".into()),
                onto: "main".into(),
            },
        )
        .unwrap();
    assert_eq!(env.head_branch(), "feature");
    assert_eq!(env.rev("feature~2"), env.rev("main"));
    let again = env
        .repos
        .rebase(
            env.id,
            RebaseRequest {
                branch: None,
                onto: "main".into(),
            },
        )
        .unwrap();
    assert_eq!(again.effect, HistoryEffect::UpToDate);
    // main is behind feature now: rebasing it fast-forwards.
    let ff = env
        .repos
        .rebase(
            env.id,
            RebaseRequest {
                branch: Some("main".into()),
                onto: "feature".into(),
            },
        )
        .unwrap();
    assert_eq!(ff.effect, HistoryEffect::FastForward);
    assert_eq!(env.rev("main"), env.rev("feature"));

    let (code, _) = fails(env.repos.rebase(
        env.id,
        RebaseRequest {
            branch: Some("--root".into()),
            onto: "main".into(),
        },
    ));
    assert_eq!(code, ErrorCode::RevisionNotFound);
}

#[test]
fn rebase_stops_on_conflicts_with_labels_then_continues_skips_or_aborts() {
    let env = rebase_env(true);
    env.fx.git(&["switch", "-q", "feature"]);
    let feature = env.rev("feature");
    let rebase = || {
        env.repos.rebase(
            env.id,
            RebaseRequest {
                branch: None,
                onto: "main".into(),
            },
        )
    };
    let (code, err) = fails(rebase());
    assert_eq!(code, ErrorCode::Conflicts, "{err:?}");
    match env.operation() {
        Some(RepoOperation::Rebase {
            step,
            total,
            head_name,
            ..
        }) => {
            assert_eq!((step, total), (Some(1), Some(2)));
            assert_eq!(head_name.as_deref(), Some("feature"));
        }
        other => panic!("{other:?}"),
    }
    let detail = env.repos.operation_detail(env.id).unwrap().unwrap();
    // In a rebase, ours is the branch replayed onto, theirs the replayed commit.
    assert_eq!(detail.labels.ours.branch.as_deref(), Some("main"));
    assert_eq!(detail.labels.theirs.branch.as_deref(), Some("feature"));
    assert_eq!(
        detail
            .labels
            .theirs
            .commit
            .as_ref()
            .map(|c| c.summary.as_str()),
        Some("feature: edit src")
    );
    assert_eq!(detail.message.as_deref(), Some("feature: edit src"));
    assert!(detail.can_skip);
    let versions = env.repos.conflict_versions(env.id, "src.txt").unwrap();
    assert_eq!(versions.ours.unwrap().text.as_deref(), Some("main\n"));
    assert_eq!(versions.theirs.unwrap().text.as_deref(), Some("feature\n"));

    // Abort: back on feature, untouched.
    env.repos.abort_operation(env.id).unwrap();
    assert_eq!(env.operation(), None);
    assert_eq!(env.head_branch(), "feature");
    assert_eq!(env.rev("feature"), feature);

    // Skip the conflicting commit: only the second one is replayed.
    fails(rebase());
    let skipped = env.repos.skip_operation(env.id).unwrap();
    assert_eq!(skipped.previous_head.as_deref(), Some(feature.as_str()));
    assert_eq!(env.operation(), None);
    assert_eq!(env.rev("feature~1"), env.rev("main"));
    assert_eq!(env.subject("feature"), "feature: add file");

    // Continue with a new message: the replayed commit keeps its author.
    env.fx.git(&["reset", "-q", "--hard", &feature]);
    fails(rebase());
    env.write("src.txt", "main and feature\n");
    env.resolve(&["src.txt"], ConflictResolution::MarkResolved);
    let done = env
        .repos
        .continue_operation(env.id, Some("feature: edit src, rebased".into()))
        .unwrap();
    assert_eq!(done.effect, HistoryEffect::Commits);
    assert_eq!(env.operation(), None);
    assert_eq!(env.head_branch(), "feature");
    assert_eq!(env.subject("feature~1"), "feature: edit src, rebased");
    assert_eq!(env.subject("feature"), "feature: add file");
    assert_eq!(env.rev("feature~2"), env.rev("main"));
    assert_eq!(
        env.out(&[
            "log",
            "-1",
            "--format=%an <%ae> %ad",
            "--date=raw",
            "feature~1"
        ]),
        env.out(&[
            "log",
            "-1",
            "--format=%an <%ae> %ad",
            "--date=raw",
            &format!("{feature}~1")
        ])
    );
}

#[test]
fn rebase_refuses_local_changes() {
    let env = rebase_env(false);
    env.fx.git(&["switch", "-q", "feature"]);
    env.write("src.txt", "dirty\n");
    let (code, err) = fails(env.repos.rebase(
        env.id,
        RebaseRequest {
            branch: None,
            onto: "main".into(),
        },
    ));
    assert_eq!(code, ErrorCode::DirtyWorktree, "{err:?}");
    assert_eq!(env.read("src.txt").as_deref(), Some("dirty\n"));
}

// --- Cherry-pick ------------------------------------------------------------------------

#[test]
fn cherry_pick_applies_commits_in_graph_order() {
    let env = env();
    env.fx.git(&["switch", "-q", "-c", "picks"]);
    env.commit("p.txt", "1\n", "pick 1");
    env.commit("p.txt", "2\n", "pick 2");
    env.commit("p.txt", "3\n", "pick 3");
    env.fx.git(&["switch", "-q", "main"]);
    let main = env.rev("main");
    // Given newest first: applied oldest first, else "pick 2" would conflict.
    let commits = vec![env.rev("picks"), env.rev("picks~2"), env.rev("picks~1")];
    let result = env
        .repos
        .cherry_pick(
            env.id,
            CherryPickRequest {
                commits,
                mainline: None,
            },
        )
        .unwrap();
    assert_eq!(result.effect, HistoryEffect::Commits);
    assert_eq!(result.previous_head.as_deref(), Some(main.as_str()));
    assert_eq!(env.rev("HEAD~3"), main);
    assert_eq!(env.subject("HEAD~2"), "pick 1");
    assert_eq!(env.subject("HEAD"), "pick 3");
    assert_eq!(env.read("p.txt").as_deref(), Some("3\n"));
}

#[test]
fn cherry_pick_conflict_continues_the_sequence() {
    let env = env();
    env.fx.git(&["switch", "-q", "-c", "picks"]);
    env.commit("src.txt", "picked\n", "pick edits src");
    env.commit("q.txt", "q\n", "pick adds q");
    env.fx.git(&["switch", "-q", "main"]);
    env.commit("src.txt", "main\n", "main edits src");
    let commits = vec![env.rev("picks~1"), env.rev("picks")];
    let (code, err) = fails(env.repos.cherry_pick(
        env.id,
        CherryPickRequest {
            commits,
            mainline: None,
        },
    ));
    assert_eq!(code, ErrorCode::Conflicts, "{err:?}");
    assert_eq!(env.operation(), Some(RepoOperation::CherryPick));
    let detail = env.repos.operation_detail(env.id).unwrap().unwrap();
    assert_eq!(detail.labels.ours.branch.as_deref(), Some("main"));
    assert_eq!(
        detail
            .labels
            .theirs
            .commit
            .as_ref()
            .map(|c| c.summary.as_str()),
        Some("pick edits src")
    );
    env.resolve(&["src.txt"], ConflictResolution::Theirs);
    env.repos.continue_operation(env.id, None).unwrap();
    assert_eq!(env.operation(), None);
    assert_eq!(env.subject("HEAD~1"), "pick edits src");
    assert_eq!(env.subject("HEAD"), "pick adds q");
    assert_eq!(
        env.out(&["log", "-1", "--format=%an", "HEAD~1"]),
        "yaggui Tests"
    );
}

#[test]
fn cherry_pick_of_an_applied_commit_stops_empty_and_skips() {
    let env = env();
    env.fx.git(&["switch", "-q", "-c", "picks"]);
    env.commit("p.txt", "1\n", "pick 1");
    env.fx.git(&["switch", "-q", "main"]);
    env.commit("p.txt", "1\n", "same change on main");
    let head = env.rev("HEAD");
    let (code, err) = fails(env.repos.cherry_pick(
        env.id,
        CherryPickRequest {
            commits: vec!["picks".into()],
            mainline: None,
        },
    ));
    assert_eq!(code, ErrorCode::EmptyCommit, "{err:?}");
    assert_eq!(env.operation(), Some(RepoOperation::CherryPick));
    let (code, _) = fails(env.repos.continue_operation(env.id, None));
    assert_eq!(code, ErrorCode::EmptyCommit);
    let skipped = env.repos.skip_operation(env.id).unwrap();
    assert_eq!(skipped.effect, HistoryEffect::UpToDate);
    assert_eq!(env.operation(), None);
    assert_eq!(env.rev("HEAD"), head);
}

/// main with a merge commit of `side` (adds `side.txt`) on top.
fn merge_commit_env() -> Env {
    let env = env();
    env.fx.git(&["switch", "-q", "-c", "side"]);
    env.commit("side.txt", "side\n", "side adds file");
    env.fx.git(&["switch", "-q", "main"]);
    env.commit("main.txt", "main\n", "main adds file");
    env.fx
        .git(&["merge", "-q", "--no-ff", "-m", "Merge side", "side"]);
    env
}

#[test]
fn cherry_pick_of_a_merge_needs_a_parent() {
    let env = merge_commit_env();
    let merge = env.rev("main");
    env.fx.git(&["switch", "-q", "-c", "target", "main~1"]);
    let request = |mainline| CherryPickRequest {
        commits: vec![merge.clone()],
        mainline,
    };
    let (code, _) = fails(env.repos.cherry_pick(env.id, request(None)));
    assert_eq!(code, ErrorCode::MainlineRequired);
    let (code, _) = fails(env.repos.cherry_pick(env.id, request(Some(3))));
    assert_eq!(code, ErrorCode::InvalidArgument);
    env.repos.cherry_pick(env.id, request(Some(1))).unwrap();
    assert_eq!(env.read("side.txt").as_deref(), Some("side\n"));
    assert_eq!(env.parents("HEAD"), 1);
}

// --- Revert -----------------------------------------------------------------------------

#[test]
fn revert_undoes_a_commit() {
    let env = env();
    env.commit("r.txt", "r\n", "add r");
    let result = env
        .repos
        .revert(
            env.id,
            RevertRequest {
                commit: "HEAD".into(),
                mainline: None,
            },
        )
        .unwrap();
    assert_eq!(result.effect, HistoryEffect::Commits);
    assert_eq!(env.subject("HEAD"), "Revert \"add r\"");
    assert!(env.read("r.txt").is_none());
    let (code, _) = fails(env.repos.revert(
        env.id,
        RevertRequest {
            commit: "HEAD~1".into(),
            mainline: Some(1),
        },
    ));
    assert_eq!(
        code,
        ErrorCode::InvalidArgument,
        "mainline on a plain commit"
    );
}

#[test]
fn revert_of_a_merge_keeps_the_chosen_parent() {
    let env = merge_commit_env();
    let (code, _) = fails(env.repos.revert(
        env.id,
        RevertRequest {
            commit: "HEAD".into(),
            mainline: None,
        },
    ));
    assert_eq!(code, ErrorCode::MainlineRequired);
    // Parent 1 = main: what `side` brought goes away.
    env.repos
        .revert(
            env.id,
            RevertRequest {
                commit: "HEAD".into(),
                mainline: Some(1),
            },
        )
        .unwrap();
    assert!(env.read("side.txt").is_none());
    assert_eq!(env.read("main.txt").as_deref(), Some("main\n"));
    assert_eq!(env.parents("HEAD"), 1);
    assert_eq!(env.subject("HEAD"), "Revert \"Merge side\"");
}

#[test]
fn revert_conflict_continues() {
    let env = env();
    env.commit("src.txt", "two\n", "edit src");
    env.commit("src.txt", "three\n", "edit src again");
    let (code, err) = fails(env.repos.revert(
        env.id,
        RevertRequest {
            commit: "HEAD~1".into(),
            mainline: None,
        },
    ));
    assert_eq!(code, ErrorCode::Conflicts, "{err:?}");
    assert_eq!(env.operation(), Some(RepoOperation::Revert));
    let detail = env.repos.operation_detail(env.id).unwrap().unwrap();
    assert!(detail.message.unwrap().starts_with("Revert \"edit src\""));
    assert_eq!(
        detail
            .labels
            .theirs
            .commit
            .as_ref()
            .map(|c| c.summary.as_str()),
        Some("edit src")
    );
    // Theirs is the reverted commit's parent side: `src.txt` as before "edit src".
    env.resolve(&["src.txt"], ConflictResolution::Theirs);
    env.repos.continue_operation(env.id, None).unwrap();
    assert_eq!(env.operation(), None);
    assert!(env.subject("HEAD").starts_with("Revert \"edit src\""));
}

// --- Reset ------------------------------------------------------------------------------

#[test]
fn reset_moves_the_branch_in_each_mode() {
    let env = env();
    env.commit("a.txt", "a\n", "add a");
    let target = env.rev("HEAD~1");
    let head = env.rev("HEAD");

    let soft = env
        .repos
        .reset(
            env.id,
            ResetRequest {
                target: target.clone(),
                mode: ResetMode::Soft,
            },
        )
        .unwrap();
    assert_eq!(
        (soft.previous_head.as_str(), soft.head.as_str()),
        (head.as_str(), target.as_str())
    );
    assert_eq!(soft.backup_id, None);
    assert_eq!(env.status(), "A  a.txt");

    env.fx.git(&["reset", "-q", "--hard", &head]);
    env.repos
        .reset(
            env.id,
            ResetRequest {
                target: target.clone(),
                mode: ResetMode::Mixed,
            },
        )
        .unwrap();
    assert_eq!(env.status(), "?? a.txt");
    assert_eq!(env.rev("main"), target);
}

#[test]
fn hard_reset_previews_and_backs_up_what_it_loses() {
    let env = env();
    env.commit("kept.txt", "v1\n", "add kept");
    env.commit("later.txt", "later\n", "add later");
    let target = env.rev("HEAD~1");
    // Modified, staged new file, deleted, untracked file the target... does not track,
    // untracked file the target tracks (after removing it from HEAD).
    env.write("src.txt", "local edit\n");
    env.write("new.txt", "new\n");
    env.fx.git(&["add", "new.txt"]);
    std::fs::remove_file(env.path("kept.txt")).unwrap();
    env.write("scratch.txt", "keep me\n");
    env.fx.git(&["rm", "-q", "--cached", "later.txt"]);

    let preview = env.repos.reset_preview(env.id, &target).unwrap();
    assert_eq!(preview.target, target);
    assert_eq!(preview.branch.as_deref(), Some("main"));
    assert_eq!(
        (preview.commits_left_behind, preview.commits_gained),
        (1, 0)
    );
    let lost: Vec<_> = preview
        .hard_lost
        .iter()
        .map(|f| (f.path.as_str(), f.change))
        .collect();
    assert_eq!(
        lost,
        [
            ("kept.txt", LostChange::Deleted),
            ("new.txt", LostChange::Added),
            ("src.txt", LostChange::Modified),
        ],
        "later.txt is deleted in the index and absent from the target; scratch.txt stays"
    );

    let result = env
        .repos
        .reset(
            env.id,
            ResetRequest {
                target: target.clone(),
                mode: ResetMode::Hard,
            },
        )
        .unwrap();
    assert_eq!(env.rev("main"), target);
    assert_eq!(env.read("src.txt").as_deref(), Some("line 1\n"));
    assert_eq!(env.read("kept.txt").as_deref(), Some("v1\n"));
    assert!(env.read("new.txt").is_none());
    assert_eq!(env.read("scratch.txt").as_deref(), Some("keep me\n"));
    let backup_id = result.backup_id.expect("a backup");
    let manifest = std::fs::read_to_string(
        env.fx
            .root
            .join("backups")
            .join(&backup_id)
            .join("manifest.json"),
    )
    .unwrap();
    assert!(manifest.contains("\"operation\": \"resetHard\""));
    for path in ["src.txt", "new.txt", "kept.txt"] {
        assert!(
            manifest.contains(&format!("\"path\": \"{path}\"")),
            "{manifest}"
        );
    }
}

#[test]
fn hard_reset_lists_untracked_files_the_target_tracks() {
    let env = env();
    env.commit("t.txt", "tracked\n", "add t");
    let target = env.rev("HEAD");
    env.remove("t.txt", "remove t");
    env.write("t.txt", "untracked now\n");
    let preview = env.repos.reset_preview(env.id, &target).unwrap();
    assert_eq!(preview.hard_lost.len(), 1);
    assert_eq!(preview.hard_lost[0].change, LostChange::Untracked);
    assert_eq!(preview.commits_gained, 0);
    assert_eq!(preview.commits_left_behind, 1);
    let result = env
        .repos
        .reset(
            env.id,
            ResetRequest {
                target,
                mode: ResetMode::Hard,
            },
        )
        .unwrap();
    assert!(result.backup_id.is_some());
    assert_eq!(env.read("t.txt").as_deref(), Some("tracked\n"));
}

// --- Other operations -------------------------------------------------------------------

#[test]
fn bisect_is_detected_skipped_and_ended() {
    let env = env();
    for n in 1..=4 {
        env.commit("b.txt", &format!("{n}\n"), &format!("b {n}"));
    }
    let head = env.rev("HEAD");
    env.fx.git(&["bisect", "start", "HEAD", "HEAD~4"]);
    assert_eq!(env.operation(), Some(RepoOperation::Bisect));
    let detail = env.repos.operation_detail(env.id).unwrap().unwrap();
    assert!(!detail.can_continue && detail.can_skip);
    assert_eq!(detail.message, None);
    let (code, _) = fails(env.repos.continue_operation(env.id, None));
    assert_eq!(code, ErrorCode::InvalidArgument);
    let tested = env.rev("HEAD");
    env.repos.skip_operation(env.id).unwrap();
    assert_ne!(env.rev("HEAD"), tested);
    env.repos.abort_operation(env.id).unwrap();
    assert_eq!(env.operation(), None);
    assert_eq!(env.rev("HEAD"), head);
    assert_eq!(env.head_branch(), "main");
}

#[test]
fn operations_need_an_idle_repository() {
    let env = env();
    let (code, _) = fails(env.repos.abort_operation(env.id));
    assert_eq!(code, ErrorCode::NoOperation);
    let (code, _) = fails(env.repos.skip_operation(env.id));
    assert_eq!(code, ErrorCode::NoOperation);
    let (code, _) = fails(env.merge("no-such-branch", MergeMode::FastForward));
    assert_eq!(code, ErrorCode::RevisionNotFound);
    let (code, _) = fails(env.merge("--abort", MergeMode::FastForward));
    assert_eq!(code, ErrorCode::RevisionNotFound);
}

// --- External merge tool and image preview (M3-3) ---------------------------------------

impl Env {
    /// `merge.tool = fake`, whose command runs `cmd` (with `$LOCAL`, `$REMOTE`, `$MERGED`).
    fn fake_merge_tool(&self, cmd: &str) {
        self.fx.git(&["config", "merge.tool", "fake"]);
        self.fx.git(&["config", "mergetool.fake.cmd", cmd]);
        self.fx
            .git(&["config", "mergetool.fake.trustExitCode", "true"]);
        self.fx.git(&["config", "mergetool.keepBackup", "false"]);
    }

    fn src_conflict(&self) {
        self.diverge_on_src();
        let (code, _) = fails(self.merge("other", MergeMode::NoFastForward));
        assert_eq!(code, ErrorCode::Conflicts);
    }
}

#[test]
fn merge_tool_resolves_the_file_it_saves() {
    let env = env();
    assert_eq!(env.repos.merge_tool(env.id).unwrap(), None);
    env.fake_merge_tool("cp \"$REMOTE\" \"$MERGED\"");
    assert_eq!(
        env.repos.merge_tool(env.id).unwrap().as_deref(),
        Some("fake")
    );
    env.src_conflict();

    let result = env.repos.run_merge_tool(env.id, "src.txt".into()).unwrap();
    assert!(result.resolved);
    assert_eq!(env.read("src.txt").as_deref(), Some("other\n"));
    assert_eq!(env.repos.list_conflicts(env.id).unwrap().unresolved, 0);
    assert_eq!(env.status(), "M  src.txt");
    assert!(env.sink.events().iter().any(
        |e| matches!(e, BackendEvent::OpStarted(s) if s.kind == OpKind::MergeTool && s.cancellable)
    ));
}

#[test]
fn merge_tool_closed_without_saving_leaves_the_conflict() {
    let env = env();
    env.fake_merge_tool("false");
    env.src_conflict();

    let result = env.repos.run_merge_tool(env.id, "src.txt".into()).unwrap();
    assert!(!result.resolved);
    assert_eq!(env.repos.list_conflicts(env.id).unwrap().unresolved, 1);
    assert!(env.status().starts_with("UU src.txt"));
}

#[test]
fn merge_tool_errors_are_typed() {
    let env = env();
    env.src_conflict();
    let (code, _) = fails(env.repos.run_merge_tool(env.id, "src.txt".into()));
    assert_eq!(code, ErrorCode::MergeToolMissing);

    env.fx.git(&["config", "merge.tool", "no-such-tool"]);
    let (code, err) = fails(env.repos.run_merge_tool(env.id, "src.txt".into()));
    assert_eq!(code, ErrorCode::MergeToolFailed, "{err:?}");

    env.fake_merge_tool("true");
    let (code, _) = fails(env.repos.run_merge_tool(env.id, "README.md".into()));
    assert_eq!(code, ErrorCode::InvalidArgument);
    assert_eq!(env.repos.list_conflicts(env.id).unwrap().unresolved, 1);
}

#[test]
fn merge_tool_can_be_cancelled() {
    let env = env();
    env.fake_merge_tool("sleep 30");
    env.src_conflict();
    let repos = Arc::clone(&env.repos);
    let id = env.id;
    let handle = std::thread::spawn(move || repos.run_merge_tool(id, "src.txt".into()));
    let started = env.sink.wait_for(
        std::time::Duration::from_secs(5),
        |e| matches!(e, BackendEvent::OpStarted(s) if s.kind == OpKind::MergeTool),
    );
    assert!(started);
    std::thread::sleep(std::time::Duration::from_millis(300));
    let op_id = env
        .sink
        .events()
        .iter()
        .find_map(|e| match e {
            BackendEvent::OpStarted(s) if s.kind == OpKind::MergeTool => Some(s.op_id),
            _ => None,
        })
        .unwrap();
    let start = std::time::Instant::now();
    env.repos.cancel_op(op_id).unwrap();
    let (code, _) = fails(handle.join().unwrap());
    assert_eq!(code, ErrorCode::Cancelled);
    assert!(start.elapsed() < std::time::Duration::from_secs(5));
    assert_eq!(env.repos.list_conflicts(env.id).unwrap().unresolved, 1);
}

#[test]
fn conflicted_images_are_previewed_as_data_urls() {
    let env = env();
    env.commit("logo.png", "\u{0}base", "add image");
    env.fx.git(&["switch", "-q", "-c", "other"]);
    env.commit("logo.png", "\u{0}theirs", "other image");
    env.fx.git(&["switch", "-q", "main"]);
    env.commit("logo.png", "\u{0}ours", "main image");
    fails(env.merge("other", MergeMode::NoFastForward));

    let ours = env
        .repos
        .conflict_image(env.id, "logo.png", ConflictStage::Ours)
        .unwrap();
    // "\0ours" in base64.
    assert_eq!(ours.as_deref(), Some("data:image/png;base64,AG91cnM="));
    assert!(
        env.repos
            .conflict_image(env.id, "src.txt", ConflictStage::Ours)
            .unwrap()
            .is_none(),
        "not an image"
    );
}

/// Reset while an operation is in progress (reference for the mock, M4-8): Git refuses a
/// soft reset in a merge, a mixed or hard reset ends the merge, and a hard reset in a
/// cherry-pick sequence leaves the sequence in progress.
#[test]
fn reset_during_an_operation_behaves_like_git() {
    let env = env();
    env.src_conflict();
    let head = env.rev("HEAD");
    let reset = |mode| {
        env.repos.reset(
            env.id,
            ResetRequest {
                target: head.clone(),
                mode,
            },
        )
    };
    let (code, err) = fails(reset(ResetMode::Soft));
    assert_eq!(code, ErrorCode::OperationInProgress, "{err:?}");
    assert!(matches!(env.operation(), Some(RepoOperation::Merge { .. })));
    reset(ResetMode::Mixed).unwrap();
    assert_eq!(env.operation(), None);

    env.fx.git(&["reset", "-q", "--hard", "HEAD"]);
    env.fx.git(&["switch", "-q", "-c", "picks", "HEAD~1"]);
    env.commit("src.txt", "picked\n", "pick edits src");
    env.commit("q.txt", "q\n", "pick adds q");
    env.fx.git(&["switch", "-q", "main"]);
    let (code, _) = fails(env.repos.cherry_pick(
        env.id,
        CherryPickRequest {
            commits: vec![env.rev("picks~1"), env.rev("picks")],
            mainline: None,
        },
    ));
    assert_eq!(code, ErrorCode::Conflicts);
    let head = env.rev("HEAD");
    env.repos
        .reset(
            env.id,
            ResetRequest {
                target: head,
                mode: ResetMode::Hard,
            },
        )
        .unwrap();
    assert_eq!(env.operation(), Some(RepoOperation::CherryPick));
}
