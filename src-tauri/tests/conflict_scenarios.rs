//! End-to-end conflict scenarios (M3-5): an operation stops on conflicts, then the commands
//! the UI chains (`list_conflicts`, `conflict_versions`, `resolve_conflicts`, then continue,
//! skip or abort) bring the repository to the expected Git state. Each scenario also checks
//! the `op-finished` events the front relies on.

mod common;

use std::path::Path;
use std::sync::Arc;

use common::{Fixture, RecordingSink};
use yaggui_lib::events::{BackendEvent, OpKind, OpNote, OpOutcome};
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::errors::{ErrorCode, ErrorPayload, YagguiError};
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::ops::types::{
    CherryPickRequest, ConflictKind, ConflictResolution, MergeMode, MergeRequest, PullStrategy,
    RebaseAction, RebaseRequest, RebaseTodoEntry, RevertRequest,
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

/// A `clean` fixture (`README.md`, `src.txt` on main, pushed to `origin`) opened by an
/// isolated backend. Interactive editors would block or fail: yaggui must never use them.
fn env() -> Env {
    env_with(|git| git)
}

fn env_with(configure: impl FnOnce(GitCli) -> GitCli) -> Env {
    let fx = Fixture::new("clean");
    for (key, value) in [
        ("user.name", "yaggui Tests"),
        ("user.email", "tests@yaggui.dev"),
        ("core.editor", "false"),
        ("sequence.editor", "false"),
    ] {
        fx.git(&["config", key, value]);
    }
    let sink = Arc::new(RecordingSink::default());
    let git = GitCli::new(Arc::new(CommandLog::new()), sink.clone())
        .with_env("GIT_CONFIG_NOSYSTEM", "1")
        .with_env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        );
    let git = configure(git);
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
    fn write_in(&self, dir: &Path, path: &str, content: &[u8]) {
        let full = dir.join(path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(full, content).unwrap();
    }

    fn read(&self, path: &str) -> Option<Vec<u8>> {
        std::fs::read(self.fx.repo().join(path)).ok()
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

    fn subject(&self, rev: &str) -> String {
        self.out(&["log", "-1", "--format=%s", rev])
    }

    fn parents(&self, rev: &str) -> usize {
        self.out(&["rev-list", "--parents", "-n", "1", rev])
            .split_whitespace()
            .count()
            - 1
    }

    fn status(&self) -> String {
        self.out(&["status", "--porcelain=v1", "--untracked-files=all"])
    }

    fn tree(&self, rev: &str) -> Vec<String> {
        self.out(&["ls-tree", "-r", "--name-only", rev])
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn show(&self, rev: &str, path: &str) -> Vec<u8> {
        let out = std::process::Command::new("git")
            .args(["show", &format!("{rev}:{path}")])
            .current_dir(self.fx.repo())
            .output()
            .unwrap();
        assert!(out.status.success(), "{rev}:{path} missing");
        out.stdout
    }

    /// Commits `files` (`None`: deleted) in the repository; returns the new HEAD.
    fn commit(&self, files: &[(&str, Option<&[u8]>)], message: &str) -> String {
        self.commit_in(&self.fx.repo(), files, message)
    }

    fn commit_in(&self, dir: &Path, files: &[(&str, Option<&[u8]>)], message: &str) -> String {
        for (path, content) in files {
            match content {
                Some(content) => self.write_in(dir, path, content),
                None => {
                    let _ = std::fs::remove_file(dir.join(path));
                }
            }
        }
        self.fx.git_in(dir, &["add", "-A"]);
        self.fx.git_in(dir, &["commit", "-q", "-m", message]);
        self.rev("HEAD")
    }

    fn operation(&self) -> Option<RepoOperation> {
        self.repos.state(self.id).unwrap().operation
    }

    fn resolve(&self, path: &str, resolution: ConflictResolution) {
        self.repos
            .resolve_conflicts(self.id, vec![path.to_owned()], resolution)
            .unwrap();
    }

    /// Conflicted files as `list_conflicts` returns them: path, kind, binary, resolved.
    fn conflicts(&self) -> Vec<(String, Option<ConflictKind>, bool, bool)> {
        self.repos
            .list_conflicts(self.id)
            .unwrap()
            .files
            .into_iter()
            .map(|f| (f.path, f.kind, f.binary, f.resolved))
            .collect()
    }

    /// Note of the last successful `op-finished` (read before `finished`, which clears).
    fn last_note(&self) -> Option<OpNote> {
        self.sink
            .events()
            .into_iter()
            .rev()
            .find_map(|event| match event {
                BackendEvent::OpFinished(e) if e.repo_id == self.id && e.kind != OpKind::Stage => {
                    match e.outcome {
                        OpOutcome::Success { note } => Some(note),
                        _ => Some(None),
                    }
                }
                _ => None,
            })?
    }

    /// `op-finished` events of the history operations since the last call: kind and error
    /// code (`resolve_conflicts` reports as `stage`, left out).
    fn finished(&self) -> Vec<(OpKind, Option<ErrorCode>)> {
        let events = self.sink.events();
        self.sink.clear();
        events
            .into_iter()
            .filter_map(|event| match event {
                BackendEvent::OpFinished(e) if e.repo_id == self.id && e.kind != OpKind::Stage => {
                    Some((
                        e.kind,
                        match e.outcome {
                            OpOutcome::Success { .. } => None,
                            OpOutcome::Failed { error } => Some(error.code),
                            OpOutcome::Cancelled => Some(ErrorCode::Cancelled),
                        },
                    ))
                }
                _ => None,
            })
            .collect()
    }

    /// Branch `feature` from main with two commits, each conflicting with main: `f1` edits
    /// `src.txt`, `f2` edits `second.txt`; main edits both. Leaves `feature` checked out.
    /// Returns main's tip and the two feature commits.
    fn two_conflicting_commits(&self) -> (String, String, String) {
        self.commit(&[("second.txt", Some(b"base\n"))], "add second");
        self.fx.git(&["switch", "-q", "-c", "feature"]);
        let f1 = self.commit(&[("src.txt", Some(b"feature 1\n"))], "f1: edit src");
        let f2 = self.commit(&[("second.txt", Some(b"feature 2\n"))], "f2: edit second");
        self.fx.git(&["switch", "-q", "main"]);
        let main = self.commit(
            &[
                ("src.txt", Some(b"main\n")),
                ("second.txt", Some(b"main\n")),
            ],
            "main edits both",
        );
        self.fx.git(&["switch", "-q", "feature"]);
        (main, f1, f2)
    }
}

fn fails<T: std::fmt::Debug>(result: Result<T, YagguiError>) -> YagguiError {
    result.expect_err("expected an error")
}

fn stopped(err: &YagguiError) -> (Option<RepoOperation>, Vec<String>) {
    assert_eq!(err.code, ErrorCode::Conflicts, "{err:?}");
    match err.payload.as_deref() {
        Some(ErrorPayload::Conflicts { operation, paths }) => (operation.clone(), paths.clone()),
        other => panic!("expected a conflicts payload, got {other:?}"),
    }
}

fn rebase_step(operation: Option<RepoOperation>) -> (Option<u32>, Option<u32>, Option<String>) {
    match operation {
        Some(RepoOperation::Rebase {
            step,
            total,
            head_name,
            ..
        }) => (step, total, head_name),
        other => panic!("expected a rebase, got {other:?}"),
    }
}

// --- Merge: content, deleted / modified and binary at once ------------------------------

#[test]
fn merge_with_content_delete_and_binary_conflicts_resolves_and_continues() {
    let env = env();
    env.commit(
        &[
            ("gone.txt", Some(b"base\n")),
            ("logo.bin", Some(b"\x89PNG\0base")),
            ("crlf.txt", Some(b"one\r\ntwo\r\n")),
        ],
        "add files",
    );
    env.fx.git(&["switch", "-q", "-c", "other"]);
    env.commit(
        &[
            ("src.txt", Some(b"other\n")),
            ("gone.txt", None),
            ("logo.bin", Some(b"\x89PNG\0theirs")),
            ("crlf.txt", Some(b"one\r\ntwo (other)\r\n")),
        ],
        "other: four conflicts",
    );
    env.fx.git(&["switch", "-q", "main"]);
    let main = env.commit(
        &[
            ("src.txt", Some(b"main\n")),
            ("gone.txt", Some(b"main edit\n")),
            ("logo.bin", Some(b"\x89PNG\0ours")),
            ("crlf.txt", Some(b"one\r\ntwo (main)\r\n")),
        ],
        "main: four conflicts",
    );
    env.finished();

    let err = fails(env.repos.merge(
        env.id,
        MergeRequest {
            source: "other".into(),
            mode: MergeMode::NoFastForward,
            message: None,
        },
    ));
    let (operation, paths) = stopped(&err);
    assert_eq!(operation, Some(RepoOperation::Merge { squash: false }));
    assert_eq!(paths, ["crlf.txt", "gone.txt", "logo.bin", "src.txt"]);
    assert_eq!(
        env.finished(),
        [(OpKind::Merge, Some(ErrorCode::Conflicts))],
        "the stop is reported as a failed op-finished"
    );

    assert_eq!(
        env.conflicts(),
        [
            ("crlf.txt".into(), Some(ConflictKind::Content), false, false),
            (
                "gone.txt".into(),
                Some(ConflictKind::DeletedByThem),
                false,
                false
            ),
            ("logo.bin".into(), Some(ConflictKind::Content), true, false),
            ("src.txt".into(), Some(ConflictKind::Content), false, false),
        ]
    );
    let gone = env.repos.conflict_versions(env.id, "gone.txt").unwrap();
    assert!(gone.theirs.is_none(), "deleted on their side");
    assert_eq!(gone.ours.unwrap().text.as_deref(), Some("main edit\n"));
    assert_eq!(gone.labels.ours.branch.as_deref(), Some("main"));
    assert_eq!(gone.labels.theirs.branch.as_deref(), Some("other"));
    let logo = env.repos.conflict_versions(env.id, "logo.bin").unwrap();
    assert!(logo.ours.as_ref().unwrap().binary && logo.ours.unwrap().text.is_none());
    let crlf = env.repos.conflict_versions(env.id, "crlf.txt").unwrap();
    assert!(crlf.merged.unwrap().text.unwrap().contains("\r\n"));

    let detail = env.repos.operation_detail(env.id).unwrap().unwrap();
    assert_eq!((detail.unresolved, detail.can_continue), (4, false));
    assert_eq!(
        fails(env.repos.continue_operation(env.id, None)).code,
        ErrorCode::UnresolvedConflicts
    );

    // The editor saves the result with the file's own line endings (M3-3).
    env.resolve(
        "crlf.txt",
        ConflictResolution::Content {
            content: "one\r\ntwo (both)\r\n".into(),
        },
    );
    env.resolve(
        "src.txt",
        ConflictResolution::Content {
            content: "main and other\n".into(),
        },
    );
    env.resolve("gone.txt", ConflictResolution::Theirs);
    env.resolve("logo.bin", ConflictResolution::Ours);
    assert!(
        env.conflicts()
            .iter()
            .all(|(_, kind, _, resolved)| *resolved && kind.is_none())
    );
    let detail = env.repos.operation_detail(env.id).unwrap().unwrap();
    assert_eq!((detail.unresolved, detail.can_continue), (0, true));
    env.finished();

    env.repos.continue_operation(env.id, None).unwrap();
    assert_eq!(env.finished(), [(OpKind::Merge, None)]);
    assert_eq!(env.operation(), None);
    assert_eq!(env.status(), "");
    assert_eq!(env.parents("HEAD"), 2);
    assert_eq!(env.rev("HEAD^1"), main);
    assert_eq!(env.subject("HEAD"), "Merge branch 'other'");
    assert!(!env.tree("HEAD").contains(&"gone.txt".to_owned()));
    assert_eq!(env.show("HEAD", "src.txt"), b"main and other\n");
    assert_eq!(env.show("HEAD", "logo.bin"), b"\x89PNG\0ours");
    assert_eq!(env.show("HEAD", "crlf.txt"), b"one\r\ntwo (both)\r\n");
    assert!(env.repos.list_conflicts(env.id).unwrap().files.is_empty());
}

#[test]
fn merge_abort_restores_the_branch() {
    let env = env();
    let (main, _, _) = env.two_conflicting_commits();
    env.fx.git(&["switch", "-q", "main"]);
    stopped(&fails(env.repos.merge(
        env.id,
        MergeRequest {
            source: "feature".into(),
            mode: MergeMode::FastForward,
            message: None,
        },
    )));
    env.resolve("src.txt", ConflictResolution::Ours);
    env.finished();

    env.repos.abort_operation(env.id).unwrap();
    assert_eq!(env.last_note(), Some(OpNote::Aborted));
    assert_eq!(env.finished(), [(OpKind::Merge, None)]);
    assert_eq!(env.operation(), None);
    assert_eq!(env.rev("HEAD"), main);
    assert_eq!(env.status(), "");
    assert_eq!(
        fails(env.repos.abort_operation(env.id)).code,
        ErrorCode::NoOperation
    );
}

// --- Rebase: a second conflict after continue, skip, abort ------------------------------

#[test]
fn rebase_stops_twice_and_continues_to_the_end() {
    let env = env();
    let (main, _, _) = env.two_conflicting_commits();
    env.finished();

    let err = fails(env.repos.rebase(
        env.id,
        RebaseRequest {
            branch: None,
            onto: main.clone(),
        },
    ));
    let (operation, paths) = stopped(&err);
    assert_eq!(paths, ["src.txt"]);
    assert_eq!(
        rebase_step(operation),
        (Some(1), Some(2), Some("feature".into()))
    );
    assert_eq!(
        env.finished(),
        [(OpKind::Rebase, Some(ErrorCode::Conflicts))]
    );

    // In a rebase, ours is the branch replayed onto, theirs the replayed commit.
    let versions = env.repos.conflict_versions(env.id, "src.txt").unwrap();
    assert_eq!(versions.ours.unwrap().text.as_deref(), Some("main\n"));
    assert_eq!(
        versions.theirs.unwrap().text.as_deref(),
        Some("feature 1\n")
    );
    assert_eq!(versions.labels.ours.branch.as_deref(), Some("main"));
    assert_eq!(versions.labels.theirs.branch.as_deref(), Some("feature"));
    assert_eq!(
        versions
            .labels
            .theirs
            .commit
            .as_ref()
            .map(|c| c.summary.as_str()),
        Some("f1: edit src")
    );
    assert!(
        env.repos
            .operation_detail(env.id)
            .unwrap()
            .unwrap()
            .can_skip
    );

    env.resolve("src.txt", ConflictResolution::Theirs);
    let err = fails(env.repos.continue_operation(env.id, None));
    let (operation, paths) = stopped(&err);
    assert_eq!(paths, ["second.txt"], "second conflict, on the next commit");
    assert_eq!(rebase_step(operation).0, Some(2));
    assert_eq!(
        env.finished(),
        [(OpKind::Rebase, Some(ErrorCode::Conflicts))]
    );
    assert_eq!(
        env.conflicts(),
        [(
            "second.txt".into(),
            Some(ConflictKind::Content),
            false,
            false
        )],
        "the files resolved at the first stop are no longer listed"
    );

    env.resolve(
        "second.txt",
        ConflictResolution::Content {
            content: "main and feature 2\n".into(),
        },
    );
    env.repos.continue_operation(env.id, None).unwrap();
    assert_eq!(env.finished(), [(OpKind::Rebase, None)]);
    assert_eq!(env.operation(), None);
    assert_eq!(env.status(), "");
    assert_eq!(env.out(&["symbolic-ref", "--short", "HEAD"]), "feature");
    assert_eq!(env.rev("feature~2"), main);
    assert_eq!(env.subject("feature~1"), "f1: edit src");
    assert_eq!(env.subject("feature"), "f2: edit second");
    assert_eq!(env.show("feature", "src.txt"), b"feature 1\n");
    assert_eq!(env.show("feature", "second.txt"), b"main and feature 2\n");
}

#[test]
fn rebase_skip_moves_to_the_next_conflict_and_abort_restores_everything() {
    let env = env();
    let (main, _, f2) = env.two_conflicting_commits();
    stopped(&fails(env.repos.rebase(
        env.id,
        RebaseRequest {
            branch: None,
            onto: main.clone(),
        },
    )));
    env.finished();

    let err = fails(env.repos.skip_operation(env.id));
    let (operation, paths) = stopped(&err);
    assert_eq!(paths, ["second.txt"]);
    assert_eq!(rebase_step(operation).0, Some(2));
    assert_eq!(
        env.finished(),
        [(OpKind::Rebase, Some(ErrorCode::Conflicts))]
    );

    env.repos.abort_operation(env.id).unwrap();
    assert_eq!(env.finished(), [(OpKind::Rebase, None)]);
    assert_eq!(env.operation(), None);
    assert_eq!(env.status(), "");
    assert_eq!(env.out(&["symbolic-ref", "--short", "HEAD"]), "feature");
    assert_eq!(env.rev("HEAD"), f2, "abort undoes the skip too");

    // Skipping both commits leaves the branch on main.
    stopped(&fails(env.repos.rebase(
        env.id,
        RebaseRequest {
            branch: None,
            onto: main.clone(),
        },
    )));
    stopped(&fails(env.repos.skip_operation(env.id)));
    env.repos.skip_operation(env.id).unwrap();
    assert_eq!(env.operation(), None);
    assert_eq!(env.rev("feature"), main);
}

// --- Cherry-pick of two commits: skip the first, resolve the second ---------------------

#[test]
fn cherry_pick_sequence_skips_then_resolves() {
    let env = env();
    let (_, f1, f2) = env.two_conflicting_commits();
    env.fx.git(&["switch", "-q", "main"]);
    let main = env.rev("main");
    env.finished();

    let err = fails(env.repos.cherry_pick(
        env.id,
        CherryPickRequest {
            commits: vec![f2.clone(), f1.clone()],
            mainline: None,
        },
    ));
    let (operation, paths) = stopped(&err);
    assert_eq!(operation, Some(RepoOperation::CherryPick));
    assert_eq!(paths, ["src.txt"], "graph order: f1 first");
    assert_eq!(
        env.finished(),
        [(OpKind::CherryPick, Some(ErrorCode::Conflicts))]
    );
    let detail = env.repos.operation_detail(env.id).unwrap().unwrap();
    assert!(detail.can_skip);
    assert_eq!(detail.labels.ours.branch.as_deref(), Some("main"));
    assert_eq!(
        detail.labels.theirs.commit.as_ref().map(|c| c.sha.as_str()),
        Some(f1.as_str())
    );

    let (operation, paths) = stopped(&fails(env.repos.skip_operation(env.id)));
    assert_eq!(operation, Some(RepoOperation::CherryPick));
    assert_eq!(paths, ["second.txt"]);
    env.resolve("second.txt", ConflictResolution::Theirs);
    let message = env.repos.operation_detail(env.id).unwrap().unwrap().message;
    assert_eq!(message.as_deref(), Some("f2: edit second"));
    env.finished();

    env.repos.continue_operation(env.id, None).unwrap();
    assert_eq!(env.finished(), [(OpKind::CherryPick, None)]);
    assert_eq!(env.operation(), None);
    assert_eq!(env.status(), "");
    assert_eq!(env.rev("HEAD~1"), main);
    assert_eq!(env.subject("HEAD"), "f2: edit second");
    assert_eq!(env.show("HEAD", "second.txt"), b"feature 2\n");
    assert_eq!(env.show("HEAD", "src.txt"), b"main\n", "f1 was skipped");
}

// --- Revert: deleted / modified, continue and abort -------------------------------------

#[test]
fn revert_of_an_added_file_modified_since_conflicts_then_continues_or_aborts() {
    let env = env();
    let added = env.commit(&[("x.txt", Some(b"v1\n"))], "add x");
    let head = env.commit(&[("x.txt", Some(b"v2\n"))], "change x");
    env.finished();

    let revert = || {
        env.repos.revert(
            env.id,
            RevertRequest {
                commit: added.clone(),
                mainline: None,
            },
        )
    };
    let (operation, paths) = stopped(&fails(revert()));
    assert_eq!(operation, Some(RepoOperation::Revert));
    assert_eq!(paths, ["x.txt"]);
    assert_eq!(
        env.finished(),
        [(OpKind::Revert, Some(ErrorCode::Conflicts))]
    );
    assert_eq!(
        env.conflicts(),
        [(
            "x.txt".into(),
            Some(ConflictKind::DeletedByThem),
            false,
            false
        )]
    );
    let versions = env.repos.conflict_versions(env.id, "x.txt").unwrap();
    assert_eq!(versions.ours.unwrap().text.as_deref(), Some("v2\n"));
    assert!(versions.theirs.is_none());
    assert!(
        env.repos
            .operation_detail(env.id)
            .unwrap()
            .unwrap()
            .can_skip,
        "git revert --skip"
    );

    env.repos.abort_operation(env.id).unwrap();
    assert_eq!(env.operation(), None);
    assert_eq!(env.rev("HEAD"), head);
    assert_eq!(env.read("x.txt").as_deref(), Some(&b"v2\n"[..]));

    stopped(&fails(revert()));
    // Accept the deletion the revert asks for.
    env.resolve("x.txt", ConflictResolution::Theirs);
    assert!(env.read("x.txt").is_none());
    env.finished();
    env.repos.continue_operation(env.id, None).unwrap();
    assert_eq!(env.finished(), [(OpKind::Revert, None)]);
    assert_eq!(env.operation(), None);
    assert_eq!(env.status(), "");
    assert_eq!(env.rev("HEAD~1"), head);
    assert!(env.subject("HEAD").starts_with("Revert \"add x\""));
    assert!(!env.tree("HEAD").contains(&"x.txt".to_owned()));
}

// --- Interactive rebase: a conflict, then an `edit` stop --------------------------------

#[test]
fn interactive_rebase_stops_on_a_conflict_then_on_edit() {
    let env = env();
    let base = env.rev("HEAD");
    let c1 = env.commit(&[("a.txt", Some(b"a1\n"))], "c1: add a");
    let c2 = env.commit(&[("a.txt", Some(b"a2\n"))], "c2: change a");
    let c3 = env.commit(&[("b.txt", Some(b"b1\n"))], "c3: add b");
    env.finished();

    // Dropping c1 leaves c2 modifying a file that no longer exists.
    let todo = vec![
        RebaseTodoEntry {
            sha: c1,
            action: RebaseAction::Drop,
            message: None,
        },
        RebaseTodoEntry {
            sha: c2,
            action: RebaseAction::Pick,
            message: None,
        },
        RebaseTodoEntry {
            sha: c3.clone(),
            action: RebaseAction::Edit,
            message: None,
        },
    ];
    let err = fails(env.repos.interactive_rebase(env.id, base.clone(), todo));
    let (operation, paths) = stopped(&err);
    assert_eq!(paths, ["a.txt"]);
    assert_eq!(rebase_step(operation).2.as_deref(), Some("main"));
    assert_eq!(
        env.finished(),
        [(OpKind::Rebase, Some(ErrorCode::Conflicts))]
    );
    assert_eq!(
        env.conflicts(),
        [(
            "a.txt".into(),
            Some(ConflictKind::DeletedByUs),
            false,
            false
        )]
    );
    let versions = env.repos.conflict_versions(env.id, "a.txt").unwrap();
    assert!(versions.ours.is_none());
    assert_eq!(versions.theirs.unwrap().text.as_deref(), Some("a2\n"));

    env.resolve("a.txt", ConflictResolution::Theirs);
    // Continue applies c2, then stops on the `edit` of c3: a success, still in progress.
    env.repos.continue_operation(env.id, None).unwrap();
    assert_eq!(env.last_note(), Some(OpNote::Paused));
    assert_eq!(env.finished(), [(OpKind::Rebase, None)]);
    let (step, total, _) = rebase_step(env.operation());
    assert_eq!(
        (step, total),
        (Some(3), Some(3)),
        "Git counts the drop line"
    );
    assert_eq!(env.subject("HEAD"), "c3: add b");
    assert!(env.repos.list_conflicts(env.id).unwrap().files.is_empty());

    // Amend the edited commit, then finish.
    env.write_in(&env.fx.repo(), "b.txt", b"b1 amended\n");
    env.fx.git(&["add", "b.txt"]);
    env.repos.continue_operation(env.id, None).unwrap();
    assert_eq!(env.last_note(), None, "completed: no note");
    assert_eq!(env.operation(), None);
    assert_eq!(env.status(), "");
    assert_eq!(env.out(&["symbolic-ref", "--short", "HEAD"]), "main");
    assert_eq!(env.rev("HEAD~2"), base);
    assert_eq!(env.subject("HEAD~1"), "c2: change a");
    assert_eq!(env.subject("HEAD"), "c3: add b");
    assert_eq!(env.show("HEAD", "b.txt"), b"b1 amended\n");
    assert_eq!(env.show("HEAD", "a.txt"), b"a2\n");
}

// --- Pull: same error and resolution path as merge / rebase -----------------------------

impl Env {
    /// A teammate pushes a change to `src.txt`; the repository commits its own change to it.
    fn diverge_from_origin(&self) -> String {
        let other = self.fx.root.join("teammate");
        self.fx.git_in(
            &self.fx.root,
            &["clone", "-q", "origin.git", other.to_str().unwrap()],
        );
        self.fx.git_in(&other, &["config", "user.name", "Teammate"]);
        self.fx
            .git_in(&other, &["config", "user.email", "mate@yaggui.dev"]);
        self.commit_in(
            &other,
            &[("src.txt", Some(b"theirs\n"))],
            "teammate edits src",
        );
        self.fx.git_in(&other, &["push", "-q", "origin", "main"]);
        self.commit(&[("src.txt", Some(b"mine\n"))], "mine edits src")
    }
}

#[test]
fn pull_merge_conflict_resolves_like_a_merge() {
    let env = env();
    let mine = env.diverge_from_origin();
    env.finished();

    let err = fails(env.repos.pull(env.id, Some(PullStrategy::Merge)));
    let (operation, paths) = stopped(&err);
    assert_eq!(operation, Some(RepoOperation::Merge { squash: false }));
    assert_eq!(paths, ["src.txt"]);
    assert!(err.message.en.starts_with("The pull stopped on conflicts"));
    assert_eq!(env.finished(), [(OpKind::Pull, Some(ErrorCode::Conflicts))]);
    let detail = env.repos.operation_detail(env.id).unwrap().unwrap();
    assert_eq!(detail.labels.ours.branch.as_deref(), Some("main"));
    // `Merge branch 'main' of <url>`: theirs is the remote-tracking branch, not "main".
    assert_eq!(detail.labels.theirs.branch.as_deref(), Some("origin/main"));

    env.resolve(
        "src.txt",
        ConflictResolution::Content {
            content: "mine and theirs\n".into(),
        },
    );
    env.repos.continue_operation(env.id, None).unwrap();
    assert_eq!(env.operation(), None);
    assert_eq!(env.status(), "");
    assert_eq!(env.parents("HEAD"), 2);
    assert_eq!(env.rev("HEAD^1"), mine);
    assert_eq!(env.rev("HEAD^2"), env.rev("origin/main"));
    assert_eq!(env.show("HEAD", "src.txt"), b"mine and theirs\n");
}

#[test]
fn pull_rebase_conflict_resolves_like_a_rebase() {
    let env = env();
    env.diverge_from_origin();

    let err = fails(env.repos.pull(env.id, Some(PullStrategy::Rebase)));
    let (operation, paths) = stopped(&err);
    assert_eq!(paths, ["src.txt"]);
    assert_eq!(rebase_step(operation).2.as_deref(), Some("main"));
    assert!(err.message.fr.contains("rebase est en cours"));

    env.resolve("src.txt", ConflictResolution::Theirs);
    env.repos.continue_operation(env.id, None).unwrap();
    assert_eq!(env.operation(), None);
    assert_eq!(env.rev("HEAD~1"), env.rev("origin/main"));
    assert_eq!(env.subject("HEAD"), "mine edits src");
    assert_eq!(env.show("HEAD", "src.txt"), b"mine\n");
}

// --- Sequence editor: shell builtins only -----------------------------------------------

/// The sequence editor runs in the shell Git uses for editors and hooks (`/bin/sh`, or the
/// `sh` bundled with Git for Windows) and must not need any program from `PATH`: run the
/// interactive rebase with `PATH` pointing to an empty folder.
#[cfg(unix)]
#[test]
fn sequence_editor_needs_no_program_from_path() {
    let which = std::process::Command::new("sh")
        .args(["-c", "command -v git"])
        .output()
        .unwrap();
    let git_binary = String::from_utf8(which.stdout).unwrap().trim().to_owned();
    let empty = tempfile::tempdir().unwrap();
    let empty_path = empty.path().to_owned();
    let env = env_with(move |git| {
        git.set_binary(git_binary);
        git.with_env("PATH", empty_path)
    });
    let base = env.rev("HEAD");
    let c1 = env.commit(&[("a.txt", Some(b"a\n"))], "c1: add a");
    let c2 = env.commit(&[("b.txt", Some(b"b\n"))], "c2: add b");

    let result = env
        .repos
        .interactive_rebase(
            env.id,
            base.clone(),
            vec![
                RebaseTodoEntry {
                    sha: c2,
                    action: RebaseAction::Reword,
                    message: Some("c2: add b, \"quoted\" $HOME `x`".into()),
                },
                RebaseTodoEntry {
                    sha: c1,
                    action: RebaseAction::Pick,
                    message: None,
                },
            ],
        )
        .unwrap();
    assert!(result.stopped.is_none());
    assert_eq!(env.operation(), None);
    assert_eq!(env.rev("HEAD~2"), base);
    assert_eq!(env.subject("HEAD~1"), "c2: add b, \"quoted\" $HOME `x`");
    assert_eq!(env.subject("HEAD"), "c1: add a");
}
