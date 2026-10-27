//! Undo / redo (M4-1) on temporary repositories: for each undoable operation, the undo must
//! bring back exactly the Git state before it (refs, HEAD, index, working tree, stashes,
//! upstreams) and the redo the state after it.

mod common;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use common::{Fixture, RecordingSink};
use yaggui_lib::events::{BackendEvent, OpKind};
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::errors::{ErrorCode, ErrorPayload, YagguiError};
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::ops::types::{
    BranchStart, CheckoutMode, CheckoutTarget, CherryPickRequest, CommitRequest, ConfigScope,
    DeleteBranchRequest, FetchTarget, HunkChange, HunkSelection, JournalOp, MergeMode,
    MergeRequest, PathSelection, PushRequest, ResetMode, ResetRequest, RevertRequest, StashId,
    UndoBlock,
};
use yaggui_lib::git::read::diff::file_diff;
use yaggui_lib::git::read::diff::types::{DiffOptions, DiffTarget};
use yaggui_lib::repo::RepoManager;
use yaggui_lib::store::Store;

struct Env {
    fx: Fixture,
    sink: Arc<RecordingSink>,
    log: Arc<CommandLog>,
    repos: Arc<RepoManager>,
    id: u32,
}

fn env() -> Env {
    env_from("clean")
}

/// A fixture opened by an isolated backend (no watcher, backups in the fixture folder).
fn env_from(scenario: &str) -> Env {
    let fx = Fixture::new(scenario);
    fx.git(&["config", "user.name", "yaggui Tests"]);
    fx.git(&["config", "user.email", "tests@yaggui.dev"]);
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
        RepoManager::new(Arc::new(git), store, sink.clone())
            .without_watcher()
            .with_backup_dir(fx.root.join("backups")),
    );
    let id = repos.open(&fx.repo_str()).unwrap().id;
    Env {
        fx,
        sink,
        log,
        repos,
        id,
    }
}

/// Everything an undo must restore.
#[derive(Debug, Clone, PartialEq, Eq)]
struct State {
    refs: String,
    head: String,
    index: String,
    worktree: BTreeMap<String, Vec<u8>>,
    stashes: String,
    upstreams: String,
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

    fn commit(&self, path: &str, content: &str, message: &str) {
        self.write(path, content);
        self.fx.git(&["add", "-A", "--", path]);
        self.fx.git(&["commit", "-q", "-m", message]);
    }

    fn state(&self) -> State {
        let head = match self.out(&["symbolic-ref", "-q", "HEAD"]) {
            name if name.is_empty() => self.rev("HEAD"),
            name => format!("{name} {}", self.rev("HEAD")),
        };
        State {
            refs: self.out(&[
                "for-each-ref",
                "--format=%(refname) %(objectname)",
                "refs/heads",
                "refs/tags",
            ]),
            head,
            index: self.out(&["ls-files", "-s"]),
            worktree: worktree(&self.fx.repo()),
            stashes: self.out(&["stash", "list", "--format=%H %gs"]),
            upstreams: self.out(&["config", "--get-regexp", "^branch\\."]),
        }
    }

    /// Runs `op`, then checks that undo restores the state before it and redo the state
    /// after it, and that undo again restores the state before. Returns the op journaled.
    fn round_trip(&self, op: impl FnOnce(&Env)) -> JournalOp {
        let before = self.state();
        op(self);
        let after = self.state();
        assert_ne!(before, after, "the operation changed nothing");
        let entry = self.repos.undo(self.id).unwrap();
        assert!(entry.undone);
        assert_eq!(self.state(), before, "undo of {:?}", entry.op);
        let redone = self.repos.redo(self.id).unwrap();
        assert_eq!(redone.id, entry.id);
        assert!(!redone.undone);
        assert_eq!(self.state(), after, "redo of {:?}", entry.op);
        self.repos.undo(self.id).unwrap();
        assert_eq!(self.state(), before, "second undo of {:?}", entry.op);
        entry.op
    }

    fn commit_request(&self, summary: &str, amend: bool) {
        self.repos
            .commit(
                self.id,
                CommitRequest {
                    summary: summary.into(),
                    description: String::new(),
                    amend,
                    skip_hooks: true,
                },
            )
            .unwrap();
    }

    fn error_code(&self, undo: bool) -> (ErrorCode, Option<ErrorPayload>) {
        let err = if undo {
            self.repos.undo(self.id).unwrap_err()
        } else {
            self.repos.redo(self.id).unwrap_err()
        };
        (err.code, err.payload.map(|p| *p))
    }
}

/// Files of the working tree (without `.git`), with their content.
fn worktree(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if entry.file_name() == ".git" {
                continue;
            }
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let meta = std::fs::symlink_metadata(&path).unwrap();
            if meta.file_type().is_symlink() {
                let target = std::fs::read_link(&path).unwrap();
                out.insert(
                    format!("{rel} -> link"),
                    target.to_string_lossy().as_bytes().to_vec(),
                );
            } else if meta.is_dir() {
                walk(root, &path, out);
            } else {
                #[cfg(unix)]
                let rel = {
                    use std::os::unix::fs::PermissionsExt;
                    if meta.permissions().mode() & 0o111 != 0 {
                        format!("{rel} (x)")
                    } else {
                        rel
                    }
                };
                out.insert(rel, std::fs::read(&path).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

fn paths(list: &[&str]) -> PathSelection {
    PathSelection::Paths {
        paths: list.iter().map(|p| (*p).to_owned()).collect(),
    }
}

// --- Undoable operations -------------------------------------------------------------------

#[test]
fn commit() {
    let e = env();
    e.write("new.txt", "new\n");
    e.fx.git(&["add", "new.txt"]);
    let op = e.round_trip(|e| e.commit_request("add new", false));
    assert!(matches!(op, JournalOp::Commit { summary, .. } if summary == "add new"));
    // The committed changes are staged again, as before the commit.
    assert_eq!(e.out(&["diff", "--cached", "--name-only"]), "new.txt");
}

#[test]
fn first_commit_of_an_unborn_branch() {
    let e = env_from("unborn");
    e.write("a.txt", "a\n");
    e.fx.git(&["add", "a.txt"]);
    e.round_trip(|e| e.commit_request("first", false));
    assert_eq!(e.rev("HEAD"), "", "back to an unborn branch");
}

#[test]
fn commit_on_a_detached_head() {
    let e = env();
    e.fx.git(&["switch", "-q", "--detach", "HEAD~1"]);
    e.write("d.txt", "d\n");
    e.fx.git(&["add", "d.txt"]);
    e.round_trip(|e| e.commit_request("detached work", false));
}

#[test]
fn amend() {
    let e = env();
    e.write("src.txt", "amended\n");
    e.fx.git(&["add", "src.txt"]);
    let op = e.round_trip(|e| e.commit_request("add src, amended", true));
    assert!(matches!(op, JournalOp::Amend { .. }));
    assert_eq!(e.out(&["log", "-1", "--format=%s"]), "add src");
}

#[test]
fn checkout_of_a_branch_carries_local_changes_back() {
    let e = env();
    e.fx.git(&["branch", "feature", "HEAD~1"]);
    e.write("notes.txt", "local\n");
    let op = e.round_trip(|e| {
        e.repos
            .checkout(
                e.id,
                CheckoutTarget::Branch {
                    name: "feature".into(),
                },
                CheckoutMode::Carry,
            )
            .unwrap();
    });
    assert!(matches!(op, JournalOp::Checkout { branch: Some(b), .. } if b == "feature"));
    assert_eq!(e.read("notes.txt").as_deref(), Some("local\n"));
}

#[test]
fn checkout_detached() {
    let e = env();
    let first = e.rev("HEAD~1");
    e.round_trip(|e| {
        e.repos
            .checkout(
                e.id,
                CheckoutTarget::Detached { rev: first.clone() },
                CheckoutMode::Clean,
            )
            .unwrap();
    });
}

#[test]
fn checkout_of_a_remote_branch_fast_forwards_the_local_one_back() {
    let e = env();
    // `feat` one commit behind `origin/feat`.
    e.fx.git(&["branch", "feat", "HEAD"]);
    e.fx.git(&["push", "-q", "origin", "feat"]);
    e.fx.git(&["branch", "-f", "feat", "HEAD~1"]);
    let old = e.rev("refs/heads/feat");
    e.round_trip(|e| {
        e.repos
            .checkout(
                e.id,
                CheckoutTarget::Remote {
                    name: "origin/feat".into(),
                },
                CheckoutMode::Clean,
            )
            .unwrap();
    });
    assert_eq!(e.rev("refs/heads/feat"), old);
}

#[test]
fn checkout_of_a_remote_branch_creates_and_removes_the_local_one() {
    let e = env();
    e.fx.git(&["branch", "feat", "HEAD~1"]);
    e.fx.git(&["push", "-q", "origin", "feat"]);
    e.fx.git(&["branch", "-D", "feat"]);
    e.fx.git(&["fetch", "-q", "origin"]);
    e.round_trip(|e| {
        e.repos
            .checkout(
                e.id,
                CheckoutTarget::Remote {
                    name: "origin/feat".into(),
                },
                CheckoutMode::Clean,
            )
            .unwrap();
    });
    assert_eq!(e.rev("refs/heads/feat"), "");
    e.repos.redo(e.id).unwrap();
    assert_eq!(
        e.out(&["rev-parse", "--abbrev-ref", "feat@{upstream}"]),
        "origin/feat"
    );
}

#[test]
fn create_branch() {
    let e = env();
    e.round_trip(|e| {
        e.repos
            .create_branch(e.id, "topic", BranchStart::Head, false)
            .unwrap();
    });
    e.round_trip(|e| {
        e.repos
            .create_branch(
                e.id,
                "tracking",
                BranchStart::Ref {
                    full_name: "refs/remotes/origin/main".into(),
                },
                true,
            )
            .unwrap();
    });
}

#[test]
fn delete_branch_restores_it_with_its_upstream() {
    let e = env();
    e.fx.git(&["branch", "--track", "old", "origin/main"]);
    e.fx.git(&["reset", "-q", "--hard", "HEAD~1"]);
    let op = e.round_trip(|e| {
        e.repos
            .delete_branch(
                e.id,
                DeleteBranchRequest {
                    name: "old".into(),
                    force: true,
                    delete_remote: false,
                },
            )
            .unwrap();
    });
    assert!(matches!(op, JournalOp::DeleteBranch { remote: false, .. }));
}

#[test]
fn rename_the_current_branch() {
    let e = env();
    e.round_trip(|e| e.repos.rename_branch(e.id, "main", "trunk").unwrap());
    assert_eq!(e.out(&["symbolic-ref", "--short", "HEAD"]), "main");
}

#[test]
fn merge_commit_and_fast_forward() {
    let e = env();
    e.fx.git(&["switch", "-q", "-c", "feature"]);
    e.commit("feature.txt", "f\n", "feature work");
    e.fx.git(&["switch", "-q", "main"]);
    e.commit("main.txt", "m\n", "main work");
    // Local changes elsewhere survive both ways.
    e.write("untracked.txt", "u\n");
    let merge = |mode| {
        move |e: &Env| {
            e.repos
                .merge(
                    e.id,
                    MergeRequest {
                        source: "feature".into(),
                        mode,
                        message: None,
                    },
                )
                .unwrap();
        }
    };
    let op = e.round_trip(merge(MergeMode::NoFastForward));
    assert!(matches!(op, JournalOp::Merge { .. }));
    e.round_trip(merge(MergeMode::Squash));
    e.fx.git(&["reset", "-q", "--hard", "HEAD~1"]);
    e.round_trip(merge(MergeMode::FastForward));
}

#[test]
fn reset_soft_mixed_and_hard() {
    let e = env();
    e.write("src.txt", "staged\n");
    e.fx.git(&["add", "src.txt"]);
    e.write("src.txt", "unstaged\n");
    e.write("untracked.txt", "u\n");
    for mode in [ResetMode::Soft, ResetMode::Mixed, ResetMode::Hard] {
        let op = e.round_trip(|e| {
            e.repos
                .reset(
                    e.id,
                    ResetRequest {
                        target: "HEAD~1".into(),
                        mode,
                    },
                )
                .unwrap();
        });
        assert!(matches!(op, JournalOp::Reset { mode: m, .. } if m == mode));
    }
    // The hard reset lost the staged and unstaged versions: both are back.
    assert_eq!(e.read("src.txt").as_deref(), Some("unstaged\n"));
    assert_eq!(e.out(&["show", ":src.txt"]), "staged");
}

#[test]
fn hard_reset_to_head_only_drops_local_changes() {
    let e = env();
    e.write("src.txt", "local\n");
    e.write("added.txt", "a\n");
    e.fx.git(&["add", "added.txt"]);
    e.round_trip(|e| {
        e.repos
            .reset(
                e.id,
                ResetRequest {
                    target: "HEAD".into(),
                    mode: ResetMode::Hard,
                },
            )
            .unwrap();
    });
}

#[test]
fn hard_reset_redo_refuses_new_local_changes() {
    let e = env();
    e.write("README.md", "changed\n");
    e.repos
        .reset(
            e.id,
            ResetRequest {
                target: "HEAD~1".into(),
                mode: ResetMode::Hard,
            },
        )
        .unwrap();
    e.repos.undo(e.id).unwrap();
    e.write("src.txt", "new local change\n");
    let (code, payload) = e.error_code(false);
    assert_eq!(code, ErrorCode::UndoWouldOverwrite);
    assert!(
        matches!(payload, Some(ErrorPayload::UndoChanges { paths, .. }) if paths == ["src.txt"])
    );
    assert_eq!(e.read("src.txt").as_deref(), Some("new local change\n"));
}

#[test]
fn discard_paths() {
    let e = env();
    e.write("src.txt", "modified\n");
    e.write("untracked.txt", "u\n");
    e.write("staged.txt", "s\n");
    e.fx.git(&["add", "staged.txt"]);
    std::fs::remove_file(e.path("README.md")).unwrap();
    let op = e.round_trip(|e| {
        e.repos
            .discard_paths(
                e.id,
                paths(&["src.txt", "untracked.txt", "README.md"]),
                false,
            )
            .unwrap();
    });
    assert!(matches!(op, JournalOp::Discard { count: 3, .. }));
    e.round_trip(|e| {
        e.repos
            .discard_paths(e.id, PathSelection::All, true)
            .unwrap();
    });
}

#[cfg(unix)]
#[test]
fn discard_keeps_modes_and_symlinks() {
    use std::os::unix::fs::PermissionsExt;
    let e = env();
    e.write("run.sh", "echo hi\n");
    std::fs::set_permissions(e.path("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::os::unix::fs::symlink("src.txt", e.path("link")).unwrap();
    e.round_trip(|e| {
        e.repos
            .discard_paths(e.id, paths(&["run.sh", "link"]), false)
            .unwrap();
    });
}

#[test]
fn discard_hunks() {
    let e = env();
    let old: String = (1..=10).map(|n| format!("line {n}\n")).collect();
    e.commit("f.txt", &old, "numbered");
    e.write(
        "f.txt",
        &old.replace("line 2\n", "LINE 2\n")
            .replace("line 9\n", "LINE 9\n"),
    );
    let repo = gix::open(e.fx.repo()).unwrap();
    let diff = file_diff(
        &repo,
        &DiffTarget::Unstaged,
        "f.txt",
        None,
        &DiffOptions::default(),
    )
    .unwrap();
    let yaggui_lib::git::read::diff::types::DiffContent::Text(text) = &diff.content else {
        panic!("expected a text diff");
    };
    let change = HunkChange {
        path: "f.txt".into(),
        old_path: None,
        old_id: diff.old_id.clone(),
        new_id: diff.new_id.clone(),
        options: DiffOptions::default(),
        hunks: vec![HunkSelection {
            id: text.hunks[0].id.clone(),
            lines: None,
        }],
    };
    e.round_trip(|e| {
        e.repos.discard_hunks(e.id, change).unwrap();
    });
}

#[test]
fn stash_drop() {
    let e = env();
    e.write("src.txt", "older\n");
    e.fx.git(&["stash", "push", "-q", "-m", "older"]);
    e.write("src.txt", "newer\n");
    e.fx.git(&["stash", "push", "-q", "-m", "newer"]);
    let sha = e.rev("stash@{0}");
    let op = e.round_trip(|e| {
        e.repos.stash_drop(e.id, StashId { index: 0, sha }).unwrap();
    });
    assert!(matches!(op, JournalOp::StashDrop { message } if message.ends_with("newer")));
}

#[test]
fn cherry_pick_and_revert() {
    let e = env();
    e.fx.git(&["switch", "-q", "-c", "feature"]);
    e.commit("a.txt", "a\n", "a");
    e.commit("b.txt", "b\n", "b");
    let (a, b) = (e.rev("HEAD~1"), e.rev("HEAD"));
    e.fx.git(&["switch", "-q", "main"]);
    let op = e.round_trip(|e| {
        e.repos
            .cherry_pick(
                e.id,
                CherryPickRequest {
                    commits: vec![a.clone(), b.clone()],
                    mainline: None,
                },
            )
            .unwrap();
    });
    assert!(matches!(op, JournalOp::CherryPick { count: 2 }));
    let head = e.rev("HEAD");
    let op = e.round_trip(|e| {
        e.repos
            .revert(
                e.id,
                RevertRequest {
                    commit: head.clone(),
                    mainline: None,
                },
            )
            .unwrap();
    });
    assert!(matches!(op, JournalOp::Revert { sha } if sha == head));
}

// --- Refusals ------------------------------------------------------------------------------

#[test]
fn nothing_to_undo_or_redo() {
    let e = env();
    assert_eq!(e.error_code(true).0, ErrorCode::NothingToUndo);
    assert_eq!(e.error_code(false).0, ErrorCode::NothingToRedo);
    let state = e.repos.undo_state(e.id).unwrap();
    assert!(state.undo.is_none() && state.redo.is_none());
}

#[test]
fn a_ref_moved_elsewhere_is_refused() {
    let e = env();
    e.repos
        .create_branch(e.id, "topic", BranchStart::Head, false)
        .unwrap();
    // A terminal moves the branch after yaggui created it.
    e.fx.git(&["branch", "-f", "topic", "HEAD~1"]);
    let state = e.repos.undo_state(e.id).unwrap();
    assert_eq!(
        state.undo.unwrap().blocked,
        Some(UndoBlock::Diverged {
            refs: vec!["refs/heads/topic".into()]
        })
    );
    let before = e.state();
    let (code, payload) = e.error_code(true);
    assert_eq!(code, ErrorCode::UndoDiverged);
    assert!(
        matches!(payload, Some(ErrorPayload::UndoChanges { refs, .. }) if refs == ["refs/heads/topic"])
    );
    assert_eq!(e.state(), before, "nothing changed");
}

#[test]
fn a_commit_made_elsewhere_blocks_the_undo_of_the_previous_one() {
    let e = env();
    e.write("x.txt", "x\n");
    e.fx.git(&["add", "x.txt"]);
    e.commit_request("from yaggui", false);
    e.commit("y.txt", "y\n", "from a terminal");
    assert_eq!(e.error_code(true).0, ErrorCode::UndoDiverged);
}

#[test]
fn undo_that_would_overwrite_local_changes_is_refused() {
    let e = env();
    e.fx.git(&["switch", "-q", "-c", "feature"]);
    e.commit("src.txt", "feature\n", "feature changes src");
    e.fx.git(&["switch", "-q", "main"]);
    e.repos
        .merge(
            e.id,
            MergeRequest {
                source: "feature".into(),
                mode: MergeMode::FastForward,
                message: None,
            },
        )
        .unwrap();
    e.write("src.txt", "local edit\n");
    let before = e.state();
    let (code, payload) = e.error_code(true);
    assert_eq!(code, ErrorCode::UndoWouldOverwrite);
    assert!(
        matches!(payload, Some(ErrorPayload::UndoChanges { paths, .. }) if paths == ["src.txt"])
    );
    assert_eq!(e.state(), before, "nothing changed");
    // The entry stays undoable once the change is out of the way.
    e.fx.git(&["checkout", "--", "src.txt"]);
    e.repos.undo(e.id).unwrap();
}

#[test]
fn a_file_changed_after_a_discard_is_not_overwritten() {
    let e = env();
    e.write("src.txt", "work\n");
    e.repos
        .discard_paths(e.id, paths(&["src.txt"]), false)
        .unwrap();
    e.write("src.txt", "newer work\n");
    let (code, _) = e.error_code(true);
    assert_eq!(code, ErrorCode::UndoWouldOverwrite);
    assert_eq!(e.read("src.txt").as_deref(), Some("newer work\n"));
}

#[test]
fn a_mixed_reset_undo_keeps_staged_changes_made_since() {
    let e = env();
    e.repos
        .reset(
            e.id,
            ResetRequest {
                target: "HEAD~1".into(),
                mode: ResetMode::Mixed,
            },
        )
        .unwrap();
    e.write("new.txt", "n\n");
    e.fx.git(&["add", "new.txt"]);
    let (code, payload) = e.error_code(true);
    assert_eq!(code, ErrorCode::UndoWouldOverwrite);
    assert!(
        matches!(payload, Some(ErrorPayload::UndoChanges { paths, .. }) if paths == ["new.txt"])
    );
}

#[test]
fn push_and_fetch_with_prune_are_journaled_as_not_undoable() {
    let e = env();
    e.commit("p.txt", "p\n", "to push");
    e.repos
        .push(
            e.id,
            PushRequest {
                remote: None,
                branch: None,
                set_upstream: false,
                force_with_lease: false,
                expected_sha: None,
            },
        )
        .unwrap();
    let state = e.repos.undo_state(e.id).unwrap();
    let undo = state.undo.unwrap();
    assert!(matches!(
        undo.entry.op,
        JournalOp::Push { delete: false, .. }
    ));
    assert_eq!(undo.blocked, Some(UndoBlock::Published));
    let (code, payload) = e.error_code(true);
    assert_eq!(code, ErrorCode::UndoBlocked);
    assert_eq!(
        payload,
        Some(ErrorPayload::UndoBlocked {
            reason: UndoBlock::Published
        })
    );

    // A plain fetch is not journaled; with prune it is, blocked.
    e.repos.fetch(e.id, FetchTarget::All, false).unwrap();
    assert_eq!(e.repos.op_history(e.id).unwrap().len(), 1);
    e.repos.fetch(e.id, FetchTarget::All, true).unwrap();
    let history = e.repos.op_history(e.id).unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].blocked, Some(UndoBlock::Pruned));
}

// --- Journal -------------------------------------------------------------------------------

#[test]
fn history_redo_stack_and_events() {
    let e = env();
    e.repos
        .create_branch(e.id, "one", BranchStart::Head, false)
        .unwrap();
    e.repos
        .create_branch(e.id, "two", BranchStart::Head, false)
        .unwrap();
    e.repos.undo(e.id).unwrap();
    let state = e.repos.undo_state(e.id).unwrap();
    assert!(
        matches!(state.undo.unwrap().entry.op, JournalOp::CreateBranch { name } if name == "one")
    );
    assert!(
        matches!(state.redo.unwrap().entry.op, JournalOp::CreateBranch { name } if name == "two")
    );

    // A new operation clears the redo stack; the undone entry stays in the history.
    e.repos
        .create_branch(e.id, "three", BranchStart::Head, false)
        .unwrap();
    assert!(e.repos.undo_state(e.id).unwrap().redo.is_none());
    let history = e.repos.op_history(e.id).unwrap();
    let names: Vec<(String, bool)> = history
        .iter()
        .map(|h| match &h.op {
            JournalOp::CreateBranch { name } => (name.clone(), h.undone),
            other => panic!("unexpected {other:?}"),
        })
        .collect();
    assert_eq!(
        names,
        [
            ("three".to_owned(), false),
            ("two".to_owned(), true),
            ("one".to_owned(), false)
        ]
    );
    assert!(history[0].at >= history[2].at && history[2].at > 0.0);

    // Undo runs on the queue like any write, logs its Git commands and tells the UI.
    let events = e.sink.events();
    assert!(
        events
            .iter()
            .any(|ev| matches!(ev, BackendEvent::OpStarted(s) if s.kind == OpKind::Undo))
    );
    assert!(
        events
            .iter()
            .any(|ev| matches!(ev, BackendEvent::JournalChanged(j) if j.repo_id == e.id))
    );
    assert!(
        e.log
            .entries()
            .iter()
            .any(|entry| entry.args.first().map(String::as_str) == Some("update-ref"))
    );
}

#[test]
fn operations_that_change_nothing_are_not_journaled() {
    let e = env();
    e.repos
        .checkout(
            e.id,
            CheckoutTarget::Branch {
                name: "main".into(),
            },
            CheckoutMode::Clean,
        )
        .unwrap();
    e.repos
        .merge(
            e.id,
            MergeRequest {
                source: "HEAD~1".into(),
                mode: MergeMode::FastForward,
                message: None,
            },
        )
        .unwrap();
    assert!(e.repos.op_history(e.id).unwrap().is_empty());
}

// --- Writes added by M4 (M4-8 audit) -------------------------------------------------------
//
// Stash of selected files and `.gitignore` (M4-7a): `tests/commit_stash.rs`; branch cleanup
// (M4-7b): `tests/graph_tools.rs`; remotes and tags (M4-7c): `tests/remotes_tags.rs`;
// worktrees, LFS and submodules (M4-5): `tests/modules.rs`. The cases below cover what those
// files leave out.

impl Env {
    fn remote_urls(&self) -> String {
        self.out(&[
            "config",
            "--get-regexp",
            "^remote\\.origin\\.(url|pushurl)$",
        ])
    }
}

#[test]
fn remote_url_changes_are_undone_and_redone() {
    let e = env();
    let before = e.remote_urls();
    e.repos
        .set_remote_urls(
            e.id,
            "origin",
            "https://example.com/new.git",
            Some("ssh://git@example.com/new.git".into()),
        )
        .unwrap();
    let after = e.remote_urls();
    assert_ne!(before, after);
    let entry = e.repos.undo(e.id).unwrap();
    assert!(matches!(entry.op, JournalOp::SetRemoteUrls { ref name } if name == "origin"));
    assert_eq!(e.remote_urls(), before);
    e.repos.redo(e.id).unwrap();
    assert_eq!(e.remote_urls(), after);

    // Clearing the push URL is undone too; a URL changed in a terminal since blocks it.
    e.repos
        .set_remote_urls(e.id, "origin", "https://example.com/new.git", None)
        .unwrap();
    assert!(!e.remote_urls().contains("pushurl"));
    e.repos.undo(e.id).unwrap();
    assert_eq!(e.remote_urls(), after);
    e.repos.redo(e.id).unwrap();
    e.fx.git(&[
        "remote",
        "set-url",
        "origin",
        "https://example.com/other.git",
    ]);
    let (code, _) = e.error_code(true);
    assert_eq!(code, ErrorCode::UndoDiverged);
    assert!(e.remote_urls().contains("other.git"), "nothing changed");
}

#[test]
fn setting_the_same_remote_urls_is_not_journaled() {
    let e = env();
    let url = e.out(&["remote", "get-url", "origin"]);
    e.repos.set_remote_urls(e.id, "origin", &url, None).unwrap();
    assert!(e.repos.op_history(e.id).unwrap().is_empty());
}

/// Restoring a reflog entry (M4-4) is a reset or a branch creation: both undoable, even
/// when the restored commit is only reachable from the reflog.
#[test]
fn reflog_restorations_are_undone() {
    let e = env();
    e.commit("lost.txt", "lost\n", "lost commit");
    let lost = e.rev("HEAD");
    e.fx.git(&["reset", "-q", "--hard", "HEAD~1"]);
    let page = e.repos.reflog(e.id, "HEAD", 0, 10).unwrap();
    let entry = page
        .entries
        .iter()
        .find(|entry| entry.new_sha == lost)
        .expect("the lost commit is in the reflog");
    assert!(entry.exists);

    let op = e.round_trip(|e| {
        e.repos
            .create_branch(
                e.id,
                "rescued",
                BranchStart::Commit { sha: lost.clone() },
                false,
            )
            .unwrap();
    });
    assert!(matches!(op, JournalOp::CreateBranch { name } if name == "rescued"));

    let op = e.round_trip(|e| {
        e.repos
            .reset(
                e.id,
                ResetRequest {
                    target: lost.clone(),
                    mode: ResetMode::Hard,
                },
            )
            .unwrap();
    });
    assert!(matches!(
        op,
        JournalOp::Reset {
            mode: ResetMode::Hard,
            ..
        }
    ));
}

/// Git config (M4-6) and identity profiles (M4-7a) are settings, not repository state: not
/// journaled, and not a barrier for the undo of what came before.
#[test]
fn config_changes_are_not_journaled_and_do_not_block_the_undo() {
    let e = env();
    e.repos
        .create_branch(e.id, "topic", BranchStart::Head, false)
        .unwrap();
    e.repos
        .git_config_set(
            Some(e.id),
            ConfigScope::Repo,
            "pull.rebase".into(),
            Some("true".into()),
        )
        .unwrap();
    e.repos
        .set_git_identity(e.id, "Someone", "someone@yaggui.dev", ConfigScope::Repo)
        .unwrap();
    let history = e.repos.op_history(e.id).unwrap();
    assert_eq!(history.len(), 1, "only the branch: {history:?}");
    let entry = e.repos.undo(e.id).unwrap();
    assert!(matches!(entry.op, JournalOp::CreateBranch { .. }));
    assert_eq!(e.rev("refs/heads/topic"), "");
    assert_eq!(e.out(&["config", "pull.rebase"]), "true", "config kept");
}

/// `git worktree prune` (M4-5) only forgets worktrees whose folder is already gone: nothing
/// to restore, not journaled.
#[test]
fn worktree_prune_is_not_journaled() {
    let e = env();
    let folder = e.fx.root.join("wt");
    e.fx.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "wt",
        folder.to_str().unwrap(),
    ]);
    std::fs::remove_dir_all(&folder).unwrap();
    e.repos.prune_worktrees(e.id).unwrap();
    assert!(e.repos.op_history(e.id).unwrap().is_empty());
    // Compared by folder name and branch, not by substring: the main worktree's temp path
    // (e.g. macOS `/var/folders/…`) may contain "wt" by chance.
    let list = e.out(&["worktree", "list", "--porcelain"]);
    let left = list.lines().any(|line| {
        line.strip_prefix("worktree ")
            .is_some_and(|path| Path::new(path).file_name() == Some("wt".as_ref()))
            || line == "branch refs/heads/wt"
    });
    assert!(!left, "pruned worktree still listed:\n{list}");
}

// --- Checkout fast-forward and hard reset over conflicts (M9-1) ------------------------------

impl Env {
    /// `main` one commit ahead of where `feat` was made; `feat` one commit behind
    /// `origin/feat`, which adds `r.txt` and changes `src.txt`. HEAD ends on `main`.
    fn feat_behind_origin(&self) {
        self.fx.git(&["switch", "-q", "-c", "feat"]);
        self.write("r.txt", "r\n");
        self.write("src.txt", "feat\n");
        self.fx.git(&["add", "-A", "--", "r.txt", "src.txt"]);
        self.fx.git(&["commit", "-q", "-m", "feat adds r"]);
        self.fx.git(&["push", "-q", "-u", "origin", "feat"]);
        self.fx.git(&["reset", "-q", "--hard", "HEAD~1"]);
        self.fx.git(&["switch", "-q", "main"]);
        self.commit("m.txt", "m\n", "main moves on");
    }

    fn checkout_origin_feat(&self, mode: CheckoutMode) -> Result<(), YagguiError> {
        self.repos
            .checkout(
                self.id,
                CheckoutTarget::Remote {
                    name: "origin/feat".into(),
                },
                mode,
            )
            .map(drop)
    }
}

/// The checked-out branch brought up to its remote one: the undo must move the index and
/// the working tree back with it, not only the ref.
#[test]
fn checkout_of_a_remote_branch_fast_forwards_the_current_branch_back() {
    let e = env();
    e.feat_behind_origin();
    e.fx.git(&["switch", "-q", "feat"]);
    let behind = e.rev("refs/heads/feat");
    let op = e.round_trip(|e| e.checkout_origin_feat(CheckoutMode::Clean).unwrap());
    assert!(matches!(op, JournalOp::Checkout { branch: Some(b), .. } if b == "feat"));
    assert_eq!(e.rev("refs/heads/feat"), behind);
    assert_eq!(e.out(&["status", "--porcelain"]), "");
    assert!(e.read("r.txt").is_none());
}

/// Same from another branch that is not at the fast-forward target: the undo moves `feat`
/// back while it is checked out, then switches back to `main` without carrying anything.
#[test]
fn checkout_of_a_remote_branch_from_another_branch_fast_forwards_back() {
    let e = env();
    e.feat_behind_origin();
    assert_ne!(e.rev("main"), e.rev("origin/feat"));
    e.round_trip(|e| e.checkout_origin_feat(CheckoutMode::Clean).unwrap());
    assert_eq!(e.out(&["symbolic-ref", "--short", "HEAD"]), "main");
    assert_eq!(e.out(&["status", "--porcelain"]), "");
    assert!(e.read("r.txt").is_none());
}

/// Local changes the fast-forward would overwrite are refused before the switch: HEAD must
/// not move when the `merge --ff-only` that follows would be refused.
#[test]
fn checkout_refuses_local_changes_in_the_way_of_the_fast_forward() {
    let e = env();
    e.feat_behind_origin();
    let refused = |e: &Env, mode, path: &str| {
        let before = e.state();
        let err = e.checkout_origin_feat(mode).unwrap_err();
        assert_eq!(err.code, ErrorCode::DirtyWorktree, "{err:?}");
        assert!(
            matches!(err.payload.as_deref(), Some(ErrorPayload::DirtyWorktree { paths, .. }) if paths.as_slice() == [path]),
            "{err:?}"
        );
        assert_eq!(e.state(), before, "nothing moved");
    };
    // A tracked change the remote branch also changes: carrying it over the switch works,
    // the fast-forward would then refuse it.
    e.write("src.txt", "local\n");
    refused(&e, CheckoutMode::Carry, "src.txt");
    e.fx.git(&["checkout", "--", "src.txt"]);
    // An untracked file the remote branch adds.
    e.write("r.txt", "mine\n");
    refused(&e, CheckoutMode::Clean, "r.txt");
    refused(&e, CheckoutMode::Carry, "r.txt");
    assert!(e.repos.op_history(e.id).unwrap().is_empty());
    // Out of the way, the checkout goes through.
    std::fs::remove_file(e.path("r.txt")).unwrap();
    e.checkout_origin_feat(CheckoutMode::Carry).unwrap();
    assert_eq!(e.rev("refs/heads/feat"), e.rev("origin/feat"));
}

/// A hard reset over an unresolved conflict that no operation owns (a stash pop; a reset is
/// refused during a merge, M9-9): the undo puts the three stages of the file back in the
/// index, not a resolved "ours" entry.
#[test]
fn undo_of_a_hard_reset_over_a_conflict_restores_the_stages() {
    let e = env();
    e.write("src.txt", "stashed\n");
    e.fx.git(&["stash", "push", "-q"]);
    e.commit("src.txt", "main\n", "main changes src");
    e.out(&["stash", "pop"]);
    assert_eq!(e.repos.state(e.id).unwrap().operation, None);
    assert_eq!(
        e.out(&["diff", "--name-only", "--diff-filter=U"]),
        "src.txt"
    );
    let before = e.state();
    assert_eq!(
        before.index.matches("src.txt").count(),
        3,
        "{}",
        before.index
    );
    e.repos
        .reset(
            e.id,
            ResetRequest {
                target: "HEAD".into(),
                mode: ResetMode::Hard,
            },
        )
        .unwrap();
    assert_eq!(e.out(&["ls-files", "-u"]), "");
    e.repos.undo(e.id).unwrap();
    assert_eq!(e.state(), before);
}
