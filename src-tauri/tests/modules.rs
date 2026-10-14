//! Submodules, worktrees and Git LFS (M4-5) on temporary repositories: each test checks the
//! resulting Git state.

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use common::{Fixture, RecordingSink};
use yaggui_lib::events::{BackendEvent, OpKind};
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::errors::{ErrorCode, YagguiError};
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::ops::modules::{
    CreateWorktreeRequest, SubmoduleUpdateRequest, WorktreeBranch,
};
use yaggui_lib::git::ops::types::{CheckoutMode, CheckoutTarget, JournalOp, UndoBlock};
use yaggui_lib::git::read::diff::file_diff;
use yaggui_lib::git::read::diff::types::{DiffContent, DiffOptions, DiffTarget};
use yaggui_lib::git::read::lfs::LfsObject;
use yaggui_lib::git::read::state::HeadState;
use yaggui_lib::repo::RepoManager;
use yaggui_lib::store::Store;

struct Env {
    fx: Fixture,
    sink: Arc<RecordingSink>,
    repos: Arc<RepoManager>,
    id: u32,
}

fn isolated_git(sink: Arc<RecordingSink>) -> GitCli {
    isolate(GitCli::new(Arc::new(CommandLog::new()), sink))
}

fn isolate(git: GitCli) -> GitCli {
    git.with_env("GIT_CONFIG_NOSYSTEM", "1")
        .with_env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        // The fixtures' submodules are local folders: Git refuses the file transport for
        // submodules unless told otherwise.
        .with_env("GIT_CONFIG_COUNT", "1")
        .with_env("GIT_CONFIG_KEY_0", "protocol.file.allow")
        .with_env("GIT_CONFIG_VALUE_0", "always")
}

fn env_with(scenario: &str, git: impl FnOnce(Arc<RecordingSink>) -> GitCli) -> Env {
    let fx = Fixture::new(scenario);
    let sink = Arc::new(RecordingSink::default());
    let store = Arc::new(Store::open_in_memory().unwrap());
    let repos = Arc::new(
        RepoManager::new(Arc::new(git(sink.clone())), store, sink.clone())
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

fn env(scenario: &str) -> Env {
    env_with(scenario, isolated_git)
}

impl Env {
    fn gix(&self) -> gix::Repository {
        gix::open(self.fx.repo()).unwrap()
    }

    /// Output of a git command in `dir`, trimmed.
    fn git_out(&self, dir: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?} failed");
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn rev(&self, dir: &Path, rev: &str) -> String {
        self.git_out(dir, &["rev-parse", rev])
    }

    fn finished_ops(&self, kind: OpKind) -> usize {
        self.sink
            .events()
            .iter()
            .filter(|e| matches!(e, BackendEvent::OpFinished(f) if f.kind == kind))
            .count()
    }
}

fn code(result: Result<impl std::fmt::Debug, YagguiError>) -> ErrorCode {
    result.expect_err("expected an error").code
}

// --- Submodules -------------------------------------------------------------------------

#[test]
fn submodule_status_reports_expected_head_and_changes() {
    let env = env("submodule");
    let lib = env.fx.repo().join("libs/lib");
    let tip = env.rev(&env.fx.root.join("lib"), "HEAD");

    let status = env.repos.submodule_status(env.id).unwrap();
    let paths: Vec<_> = status.iter().map(|s| s.path.as_str()).collect();
    assert_eq!(paths, ["libs/lib", "libs/other"]);
    let (sub, other) = (&status[0], &status[1]);
    assert!(sub.initialized);
    assert_eq!(sub.expected.as_deref(), Some(tip.as_str()));
    assert_eq!(sub.head.as_deref(), Some(tip.as_str()));
    assert!(!sub.dirty);
    assert_eq!(PathBuf::from(&sub.absolute_path), lib);
    assert!(!other.initialized);
    assert_eq!(other.head, None);
    assert_eq!(other.expected.as_deref(), Some(tip.as_str()));

    // Moved and modified inside the submodule.
    env.fx.git_in(&lib, &["checkout", "-q", "HEAD~1"]);
    std::fs::write(lib.join("scratch.txt"), "local\n").unwrap();
    let status = env.repos.submodule_status(env.id).unwrap();
    let parent = env.rev(&lib, "HEAD");
    assert_eq!(status[0].head.as_deref(), Some(parent.as_str()));
    assert_eq!(status[0].expected.as_deref(), Some(tip.as_str()));
    assert!(status[0].dirty);

    // The superproject lists the pointer change, and its diff shows both commits.
    let unstaged = env
        .repos
        .changed_files(env.id, &DiffTarget::Unstaged)
        .unwrap();
    assert!(unstaged.files.iter().any(|f| f.path == "libs/lib"));
    let diff = file_diff(
        &env.gix(),
        &DiffTarget::Unstaged,
        "libs/lib",
        None,
        &DiffOptions::default(),
    )
    .unwrap();
    assert_eq!(
        diff.content,
        DiffContent::Submodule {
            old_commit: Some(tip),
            new_commit: Some(parent),
        }
    );
}

#[test]
fn update_submodules_inits_and_restores_the_recorded_commit() {
    let env = env("submodule");
    let lib = env.fx.repo().join("libs/lib");
    let tip = env.rev(&env.fx.root.join("lib"), "HEAD");
    env.fx.git_in(&lib, &["checkout", "-q", "HEAD~1"]);

    // Without --init, only the initialized submodule moves back.
    env.repos
        .update_submodules(
            env.id,
            SubmoduleUpdateRequest {
                paths: vec![],
                init: false,
                recursive: false,
            },
        )
        .unwrap();
    assert_eq!(env.rev(&lib, "HEAD"), tip);
    assert!(!env.fx.repo().join("libs/other/lib.txt").exists());

    env.repos
        .update_submodules(
            env.id,
            SubmoduleUpdateRequest {
                paths: vec!["libs/other".into()],
                init: true,
                recursive: true,
            },
        )
        .unwrap();
    let other = env.fx.repo().join("libs/other");
    assert_eq!(env.rev(&other, "HEAD"), tip);
    let status = env.repos.submodule_status(env.id).unwrap();
    assert!(status.iter().all(|s| s.initialized && s.head == s.expected));
    assert_eq!(env.finished_ops(OpKind::Submodule), 2);
}

#[test]
fn update_submodules_refuses_unknown_paths() {
    let env = env("submodule");
    let result = env.repos.update_submodules(
        env.id,
        SubmoduleUpdateRequest {
            paths: vec!["--init".into()],
            init: false,
            recursive: false,
        },
    );
    assert_eq!(code(result), ErrorCode::InvalidArgument);
}

// --- Worktrees --------------------------------------------------------------------------

fn worktree_paths(env: &Env) -> Vec<String> {
    let refs = env.repos.list_refs(env.id).unwrap();
    refs.worktrees.into_iter().map(|w| w.path).collect()
}

#[test]
fn create_worktree_on_a_new_branch() {
    let env = env("worktree");
    let target = env.fx.root.join("feature-wt");
    let path = env
        .repos
        .create_worktree(
            env.id,
            CreateWorktreeRequest {
                path: target.display().to_string(),
                branch: WorktreeBranch::New {
                    name: "feat/wt".into(),
                    start: "main".into(),
                },
            },
        )
        .unwrap();
    assert_eq!(PathBuf::from(&path), target);
    assert!(target.join("README.md").exists());
    assert_eq!(
        env.git_out(&target, &["symbolic-ref", "--short", "HEAD"]),
        "feat/wt"
    );
    assert_eq!(env.rev(&target, "HEAD"), env.rev(&env.fx.repo(), "main"));
    assert!(worktree_paths(&env).contains(&path));
}

#[test]
fn create_worktree_on_an_existing_branch_and_refusals() {
    let env = env("worktree");
    env.fx.git(&["branch", "spare"]);
    let target = env.fx.root.join("spare-wt");
    let request = |path: &Path, branch: WorktreeBranch| CreateWorktreeRequest {
        path: path.display().to_string(),
        branch,
    };
    let existing = |name: &str| WorktreeBranch::Existing { name: name.into() };

    env.repos
        .create_worktree(env.id, request(&target, existing("spare")))
        .unwrap();
    assert_eq!(
        env.git_out(&target, &["symbolic-ref", "--short", "HEAD"]),
        "spare"
    );

    // `wt` is checked out in the fixture's linked worktree.
    let other = env.fx.root.join("other");
    let result = env
        .repos
        .create_worktree(env.id, request(&other, existing("wt")));
    let error = result.unwrap_err();
    assert_eq!(error.code, ErrorCode::BranchInOtherWorktree);
    assert!(error.message.en.contains("wt"), "{}", error.message.en);
    assert!(!other.exists());

    let result = env
        .repos
        .create_worktree(env.id, request(&other, existing("nope")));
    assert_eq!(code(result), ErrorCode::RevisionNotFound);

    let busy = env.fx.root.join("busy");
    std::fs::create_dir_all(&busy).unwrap();
    std::fs::write(busy.join("file"), "x").unwrap();
    let result = env.repos.create_worktree(
        env.id,
        request(
            &busy,
            WorktreeBranch::New {
                name: "busy".into(),
                start: "HEAD".into(),
            },
        ),
    );
    assert_eq!(code(result), ErrorCode::TargetNotEmpty);

    let result = env.repos.create_worktree(
        env.id,
        request(
            &other,
            WorktreeBranch::New {
                name: "spare".into(),
                start: "HEAD".into(),
            },
        ),
    );
    assert_eq!(code(result), ErrorCode::RefExists);
    let result = env.repos.create_worktree(
        env.id,
        CreateWorktreeRequest {
            path: "relative/folder".into(),
            branch: existing("spare"),
        },
    );
    assert_eq!(code(result), ErrorCode::InvalidArgument);
}

#[test]
fn checkout_of_a_branch_used_by_another_worktree_is_typed() {
    let env = env("worktree");
    let result = env.repos.checkout(
        env.id,
        CheckoutTarget::Branch { name: "wt".into() },
        CheckoutMode::Clean,
    );
    assert_eq!(code(result), ErrorCode::BranchInOtherWorktree);
}

#[test]
fn remove_worktree_refuses_changes_unless_forced() {
    let env = env("worktree");
    let wt = env.fx.root.join("wt");
    let wt_str = wt.display().to_string();
    std::fs::write(wt.join("scratch.txt"), "local\n").unwrap();
    std::fs::write(wt.join("src.txt"), "edited\n").unwrap();

    let preview = env.repos.worktree_remove_preview(env.id, &wt_str).unwrap();
    assert_eq!(preview.branch.as_deref(), Some("wt"));
    assert_eq!(preview.dirty.unstaged, 1);
    assert_eq!(preview.dirty.untracked, 1);
    assert!(!preview.locked && !preview.missing);

    let result = env.repos.remove_worktree(env.id, &wt_str, false);
    assert_eq!(code(result), ErrorCode::WorktreeDirty);
    assert!(wt.exists());

    env.repos.remove_worktree(env.id, &wt_str, true).unwrap();
    assert!(!wt.exists());
    assert!(!worktree_paths(&env).contains(&wt_str));
    // The branch stays.
    env.rev(&env.fx.repo(), "refs/heads/wt");
}

#[test]
fn remove_worktree_refuses_the_main_and_locked_ones() {
    let env = env("worktree");
    let main = env.fx.repo_str();
    let result = env.repos.remove_worktree(env.id, &main, true);
    assert_eq!(code(result), ErrorCode::InvalidArgument);

    let wt = env.fx.root.join("wt");
    env.fx.git(&["worktree", "lock", wt.to_str().unwrap()]);
    let wt_str = wt.display().to_string();
    assert!(
        env.repos
            .worktree_remove_preview(env.id, &wt_str)
            .unwrap()
            .locked
    );
    let result = env.repos.remove_worktree(env.id, &wt_str, true);
    assert_eq!(code(result), ErrorCode::WorktreeLocked);
    assert!(wt.exists());
}

#[test]
fn clean_worktree_is_removed_then_missing_ones_are_pruned() {
    let env = env("worktree");
    let wt = env.fx.root.join("wt");
    env.repos
        .remove_worktree(env.id, &wt.display().to_string(), false)
        .unwrap();
    assert!(!wt.exists());

    let gone = env.fx.root.join("gone");
    env.fx.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "gone",
        gone.to_str().unwrap(),
    ]);
    let gone_str = gone.display().to_string();
    std::fs::remove_dir_all(&gone).unwrap();
    let refs = env.repos.list_refs(env.id).unwrap();
    assert!(refs.worktrees.iter().any(|w| w.prunable));
    assert!(
        env.repos
            .worktree_remove_preview(env.id, &gone_str)
            .unwrap()
            .missing
    );

    env.repos.prune_worktrees(env.id).unwrap();
    let refs = env.repos.list_refs(env.id).unwrap();
    assert_eq!(refs.worktrees.len(), 1, "{:?}", refs.worktrees);
    assert!(
        matches!(&refs.worktrees[0].head, Some(HeadState::Branch { name, .. }) if name == "main")
    );
    assert_eq!(env.finished_ops(OpKind::Worktree), 2);
}

// --- LFS (testable without git-lfs) -----------------------------------------------------

const fn oid(digit: char) -> &'static str {
    match digit {
        'a' => "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        'b' => "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        'c' => "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        _ => "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    }
}

fn lfs_object(digit: char, size: f64) -> Option<LfsObject> {
    Some(LfsObject {
        oid: Some(oid(digit).to_owned()),
        size,
    })
}

#[test]
fn lfs_files_are_flagged_and_their_pointers_never_diffed_as_text() {
    let env = env("lfs");
    let unstaged = env
        .repos
        .changed_files(env.id, &DiffTarget::Unstaged)
        .unwrap();
    assert_eq!(unstaged.lfs, ["assets/model.bin"]);
    let model = unstaged
        .files
        .iter()
        .find(|f| f.path == "assets/model.bin")
        .unwrap();
    assert_eq!(model.additions, None);
    let notes = unstaged
        .files
        .iter()
        .find(|f| f.path == "notes.txt")
        .unwrap();
    assert_eq!(notes.additions, Some(1));

    let diff = |target: DiffTarget| {
        file_diff(
            &env.gix(),
            &target,
            "assets/model.bin",
            None,
            &DiffOptions::default(),
        )
        .unwrap()
        .content
    };
    assert_eq!(
        diff(DiffTarget::Unstaged),
        DiffContent::Lfs {
            old: lfs_object('c', 2_097_152.0),
            new: lfs_object('d', 3_145_728.0),
        }
    );
    assert_eq!(
        diff(DiffTarget::Commits {
            from: None,
            to: "HEAD".into()
        }),
        DiffContent::Lfs {
            old: lfs_object('a', 1_048_576.0),
            new: lfs_object('c', 2_097_152.0),
        }
    );
    let root = env.repos.changed_files(
        env.id,
        &DiffTarget::Commits {
            from: None,
            to: "HEAD~1".into(),
        },
    );
    assert_eq!(root.unwrap().lfs, ["assets/model.bin", "assets/other.bin"]);

    // Content in the working tree (as after a `git lfs pull`): its size, not hashed.
    std::fs::write(env.fx.repo().join("assets/model.bin"), vec![0u8; 4096]).unwrap();
    assert_eq!(
        diff(DiffTarget::Unstaged),
        DiffContent::Lfs {
            old: lfs_object('c', 2_097_152.0),
            new: Some(LfsObject {
                oid: None,
                size: 4096.0
            }),
        }
    );
}

#[test]
fn lfs_status_reads_the_patterns() {
    let env = env("lfs");
    let status = env.repos.lfs_status(env.id).unwrap();
    assert_eq!(status.patterns, ["*.bin"]);
    assert!(status.used);

    let plain = self::env("clean");
    let status = plain.repos.lfs_status(plain.id).unwrap();
    assert!(!status.used);
    assert!(status.patterns.is_empty());
    assert!(
        plain
            .repos
            .changed_files(plain.id, &DiffTarget::Unstaged)
            .unwrap()
            .lfs
            .is_empty()
    );
}

/// A `PATH` holding only `git`: `git lfs` is then not installed, whatever the machine has.
#[cfg(unix)]
fn git_without_lfs(sink: Arc<RecordingSink>) -> GitCli {
    let dir = std::env::temp_dir().join(format!("yaggui-no-lfs-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let link = dir.join("git");
    if !link.exists() {
        let git = String::from_utf8(
            std::process::Command::new("sh")
                .args(["-c", "command -v git"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        std::os::unix::fs::symlink(git.trim(), &link).unwrap();
    }
    isolate(GitCli::with_binary(
        &link,
        Arc::new(CommandLog::new()),
        sink,
    ))
    .with_env("PATH", dir)
}

#[cfg(unix)]
#[test]
fn missing_git_lfs_is_reported_without_blocking() {
    let env = env_with("lfs", git_without_lfs);
    let status = env.repos.lfs_status(env.id).unwrap();
    assert_eq!(status.version, None);
    assert!(status.used);
    assert_eq!(code(env.repos.lfs_pull(env.id)), ErrorCode::LfsNotInstalled);
    assert_eq!(
        code(env.repos.lfs_track(env.id, "*.psd")),
        ErrorCode::LfsNotInstalled
    );
    // Reads keep working: the LFS view comes from the pointers.
    assert_eq!(
        env.repos
            .changed_files(env.id, &DiffTarget::Unstaged)
            .unwrap()
            .lfs,
        ["assets/model.bin"]
    );
}

#[test]
fn lfs_track_refuses_options() {
    let env = env("lfs");
    assert_eq!(
        code(env.repos.lfs_track(env.id, "--global")),
        ErrorCode::InvalidArgument
    );
}

// --- LFS with the git-lfs binary --------------------------------------------------------

#[test]
#[ignore = "needs git-lfs installed (not on every CI runner)"]
fn lfs_track_adds_the_pattern() {
    let env = env("lfs");
    assert!(env.repos.lfs_status(env.id).unwrap().version.is_some());
    env.repos.lfs_track(env.id, "*.psd").unwrap();
    let attributes = std::fs::read_to_string(env.fx.repo().join(".gitattributes")).unwrap();
    assert!(attributes.contains("*.psd filter=lfs"), "{attributes}");
    assert_eq!(
        env.repos.lfs_status(env.id).unwrap().patterns,
        ["*.bin", "*.psd"]
    );
    // The undo puts `.gitattributes` back.
    env.repos.undo(env.id).unwrap();
    assert_eq!(env.repos.lfs_status(env.id).unwrap().patterns, ["*.bin"]);
    env.repos.redo(env.id).unwrap();
    assert_eq!(
        env.repos.lfs_status(env.id).unwrap().patterns,
        ["*.bin", "*.psd"]
    );
}

#[test]
#[ignore = "needs git-lfs installed (not on every CI runner)"]
fn lfs_pull_replaces_pointers_with_content() {
    let env = env("clean");
    let repo = env.fx.repo();
    let lfs = |args: &[&str]| env.fx.git(args);
    lfs(&["lfs", "install", "--local"]);
    lfs(&["lfs", "track", "*.bin"]);
    std::fs::write(repo.join("data.bin"), "large content\n").unwrap();
    lfs(&["add", ".gitattributes", "data.bin"]);
    lfs(&["commit", "-q", "-m", "lfs file"]);
    lfs(&["push", "-q", "origin", "main"]);
    // A checkout without the content: only the pointer is there.
    let pointer = env.git_out(&repo, &["cat-file", "-p", "HEAD:data.bin"]);
    std::fs::write(repo.join("data.bin"), format!("{pointer}\n")).unwrap();

    env.repos.lfs_pull(env.id).unwrap();
    assert_eq!(
        std::fs::read_to_string(repo.join("data.bin")).unwrap(),
        "large content\n"
    );
    assert_eq!(env.finished_ops(OpKind::Lfs), 1);
    assert_eq!(code(env.repos.undo(env.id)), ErrorCode::UndoBlocked);
}

// --- Undo journal (M4-1 contract) -------------------------------------------------------

fn undo_code(env: &Env) -> ErrorCode {
    code(env.repos.undo(env.id))
}

#[test]
fn creating_a_worktree_is_undone_and_redone() {
    let env = env("worktree");
    let target = env.fx.root.join("undo-wt");
    let path = env
        .repos
        .create_worktree(
            env.id,
            CreateWorktreeRequest {
                path: target.display().to_string(),
                branch: WorktreeBranch::New {
                    name: "feat/undo".into(),
                    start: "main".into(),
                },
            },
        )
        .unwrap();

    let entry = env.repos.undo(env.id).unwrap();
    assert!(matches!(entry.op, JournalOp::CreateWorktree { .. }));
    assert!(!target.exists());
    assert!(!worktree_paths(&env).contains(&path));
    assert_eq!(
        env.git_out(&env.fx.repo(), &["branch", "--list", "feat/undo"]),
        ""
    );

    env.repos.redo(env.id).unwrap();
    assert!(target.join("README.md").exists());
    assert_eq!(
        env.git_out(&target, &["symbolic-ref", "--short", "HEAD"]),
        "feat/undo"
    );

    // Changes in the new worktree would be lost: the undo refuses.
    std::fs::write(target.join("scratch.txt"), "work\n").unwrap();
    assert_eq!(undo_code(&env), ErrorCode::UndoWouldOverwrite);
    assert!(target.exists());
}

#[test]
fn removing_a_clean_worktree_is_undone_a_dirty_one_is_blocked() {
    let env = env("worktree");
    let wt = env.fx.root.join("wt");
    let wt_str = wt.display().to_string();
    env.repos.remove_worktree(env.id, &wt_str, false).unwrap();
    let entry = env.repos.undo(env.id).unwrap();
    assert!(matches!(entry.op, JournalOp::RemoveWorktree { .. }));
    assert_eq!(env.git_out(&wt, &["symbolic-ref", "--short", "HEAD"]), "wt");
    env.repos.redo(env.id).unwrap();
    assert!(!wt.exists());
    env.repos.undo(env.id).unwrap();

    std::fs::write(wt.join("scratch.txt"), "local\n").unwrap();
    env.repos.remove_worktree(env.id, &wt_str, true).unwrap();
    let state = env.repos.undo_state(env.id).unwrap();
    assert_eq!(
        state.undo.and_then(|step| step.blocked),
        Some(UndoBlock::FilesDeleted)
    );
    assert_eq!(undo_code(&env), ErrorCode::UndoBlocked);
}

#[test]
fn submodule_update_is_a_blocked_journal_entry() {
    let env = env("submodule");
    env.repos
        .update_submodules(
            env.id,
            SubmoduleUpdateRequest {
                paths: vec![],
                init: true,
                recursive: false,
            },
        )
        .unwrap();
    let history = env.repos.op_history(env.id).unwrap();
    assert_eq!(history[0].op, JournalOp::UpdateSubmodules { count: 0 });
    assert_eq!(history[0].blocked, Some(UndoBlock::Downloaded));
    assert_eq!(undo_code(&env), ErrorCode::UndoBlocked);
}
