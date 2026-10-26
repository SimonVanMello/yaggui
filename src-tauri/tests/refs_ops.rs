//! Branches, checkout, stashes and tags (M2-3) on temporary repositories: each test checks
//! the resulting Git state.

mod common;

use std::sync::Arc;

use common::{Fixture, RecordingSink};
use yaggui_lib::events::{BackendEvent, OpKind};
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::errors::{ErrorAction, ErrorCode, ErrorPayload, YagguiError};
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::ops::types::{
    BranchStart, CheckoutMode, CheckoutTarget, CreateTagRequest, DeleteBranchRequest, RefNameKind,
    StashId, StashPushRequest,
};
use yaggui_lib::git::read::diff::types::DiffTarget;
use yaggui_lib::repo::RepoManager;
use yaggui_lib::store::Store;

struct Env {
    fx: Fixture,
    sink: Arc<RecordingSink>,
    repos: Arc<RepoManager>,
    id: u32,
}

/// A `clean` fixture (main pushed to `origin`, tracking it) opened by an isolated backend.
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
    fn write(&self, path: &str, content: &str) {
        std::fs::write(self.fx.repo().join(path), content).unwrap();
    }

    fn read(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(self.fx.repo().join(path)).ok()
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

    fn commit(&self, path: &str, content: &str, message: &str) {
        self.write(path, content);
        self.fx.git(&["add", "--", path]);
        self.fx.git(&["commit", "-q", "-m", message]);
    }

    /// Branch `other` (from main) changing `src.txt`; back on main afterwards.
    fn other_branch(&self) {
        self.fx.git(&["switch", "-q", "-c", "other"]);
        self.commit("src.txt", "other\n", "other changes src");
        self.fx.git(&["switch", "-q", "main"]);
    }

    fn stash(&self, index: u32) -> StashId {
        StashId {
            index,
            sha: self.rev(&format!("stash@{{{index}}}")),
        }
    }

    fn stash_count(&self) -> usize {
        self.out(&["stash", "list"]).lines().count()
    }

    fn status(&self) -> String {
        self.out(&["status", "--porcelain=v1", "--untracked-files=all"])
    }
}

fn code<T: std::fmt::Debug>(result: Result<T, YagguiError>) -> (ErrorCode, YagguiError) {
    let err = result.expect_err("expected an error");
    (err.code, err)
}

#[test]
fn validates_ref_names() {
    let env = env();
    let check = |kind, name: &str| env.repos.validate_ref_name(env.id, kind, name);
    assert!(check(RefNameKind::Branch, "feat/new").is_ok());
    assert!(check(RefNameKind::Tag, "v1.0.0").is_ok());
    for bad in [
        "", "a b", "a..b", "-x", "x.lock", "x/", "@{-1}", "HEAD", "a~1",
    ] {
        let (c, err) = code(check(RefNameKind::Branch, bad));
        assert_eq!(c, ErrorCode::InvalidRefName, "{bad}");
        assert!(
            err.message
                .fr
                .contains("n'est pas un nom de branche valide")
        );
    }
    assert_eq!(
        code(check(RefNameKind::Branch, "main")).0,
        ErrorCode::RefExists
    );
}

/// The live check runs no git process (nothing in the command log) and agrees with
/// `git check-ref-format`, which the operations still run.
#[test]
fn ref_name_check_matches_git_without_logging() {
    let env = env();
    let logged = || {
        env.sink
            .events()
            .iter()
            .filter(|e| matches!(e, BackendEvent::CommandLogged(_)))
            .count()
    };
    let before = logged();
    let names = [
        "feat/new",
        "v1.0.0",
        "a",
        "a/b/c",
        "x.y",
        "UPPER",
        "été",
        "a-b_c",
        "a+b",
        "a=b",
        "",
        "a b",
        "a..b",
        "-x",
        "x.lock",
        "x/",
        "/x",
        "a//b",
        "@{-1}",
        "@",
        "HEAD",
        "a~1",
        "a^b",
        "a:b",
        "a?b",
        "a*b",
        "a[b",
        "a\\b",
        ".a",
        "a/.b",
        "a.",
        "a/b.lock/c",
        "a\tb",
        "a\u{7f}b",
        "refs/heads/x",
        "a@b",
        "a@{b",
    ];
    for name in names {
        for (kind, args) in [
            (
                RefNameKind::Branch,
                vec!["check-ref-format", "--branch", name],
            ),
            (RefNameKind::Tag, vec!["check-ref-format"]),
        ] {
            let mut args: Vec<String> = args.into_iter().map(str::to_owned).collect();
            if kind == RefNameKind::Tag {
                args.push(format!("refs/tags/{name}"));
            }
            let git = std::process::Command::new("git")
                .args(&args)
                .output()
                .unwrap();
            let printed = String::from_utf8_lossy(&git.stdout);
            let git_ok = git.status.success()
                && (kind == RefNameKind::Tag || printed.trim_end() == name)
                && !name.starts_with('-')
                && name != "HEAD"
                && !name.contains("@{");
            let ours = env.repos.validate_ref_name(env.id, kind, name);
            let ours_ok = !matches!(&ours, Err(e) if e.code == ErrorCode::InvalidRefName);
            assert_eq!(ours_ok, git_ok, "{kind:?} {name:?}: {ours:?}");
        }
    }
    assert_eq!(logged(), before);
}

#[test]
fn checkout_with_compatible_changes_carries_them() {
    let env = env();
    env.other_branch();
    env.write("README.md", "# Edited\n");
    let target = CheckoutTarget::Branch {
        name: "other".into(),
    };
    let (c, err) = code(
        env.repos
            .checkout(env.id, target.clone(), CheckoutMode::Clean),
    );
    assert_eq!(c, ErrorCode::DirtyWorktree);
    assert_eq!(
        err.payload.as_deref(),
        Some(&ErrorPayload::DirtyWorktree {
            paths: vec![],
            can_carry: true
        })
    );
    assert_eq!(env.head_branch(), "main");

    let result = env
        .repos
        .checkout(env.id, target, CheckoutMode::Carry)
        .unwrap();
    assert_eq!(result.branch.as_deref(), Some("other"));
    assert_eq!(env.head_branch(), "other");
    assert_eq!(env.read("README.md").as_deref(), Some("# Edited\n"));
    assert_eq!(env.read("src.txt").as_deref(), Some("other\n"));
    assert!(env.sink.events().iter().any(|e| matches!(
        e,
        BackendEvent::OpStarted(op) if op.kind == OpKind::Checkout
    )));
}

#[test]
fn checkout_with_incompatible_changes_lists_the_files() {
    let env = env();
    env.other_branch();
    env.write("src.txt", "mine\n");
    let target = CheckoutTarget::Branch {
        name: "other".into(),
    };
    let (_, err) = code(
        env.repos
            .checkout(env.id, target.clone(), CheckoutMode::Clean),
    );
    assert_eq!(
        err.payload.as_deref(),
        Some(&ErrorPayload::DirtyWorktree {
            paths: vec!["src.txt".into()],
            can_carry: false
        })
    );
    let (c, err) = code(env.repos.checkout(env.id, target, CheckoutMode::Carry));
    assert_eq!(c, ErrorCode::DirtyWorktree);
    assert!(matches!(
        err.payload.as_deref(),
        Some(ErrorPayload::DirtyWorktree { paths, can_carry: false }) if paths == &["src.txt"]
    ));
    assert_eq!(env.head_branch(), "main");
    assert_eq!(env.read("src.txt").as_deref(), Some("mine\n"));
}

#[test]
fn stash_checkout_pop_moves_compatible_changes() {
    let env = env();
    env.other_branch();
    env.write("README.md", "# Edited\n");
    env.write("notes.txt", "untracked\n");
    env.repos
        .checkout(
            env.id,
            CheckoutTarget::Branch {
                name: "other".into(),
            },
            CheckoutMode::StashAndPop,
        )
        .unwrap();
    assert_eq!(env.head_branch(), "other");
    assert_eq!(env.read("README.md").as_deref(), Some("# Edited\n"));
    assert_eq!(env.read("notes.txt").as_deref(), Some("untracked\n"));
    assert_eq!(env.stash_count(), 0);
}

#[test]
fn stash_checkout_pop_conflict_keeps_the_stash() {
    let env = env();
    env.other_branch();
    env.write("src.txt", "mine\n");
    let (c, err) = code(env.repos.checkout(
        env.id,
        CheckoutTarget::Branch {
            name: "other".into(),
        },
        CheckoutMode::StashAndPop,
    ));
    assert_eq!(c, ErrorCode::StashConflict);
    let stash = env.rev("stash@{0}");
    assert_eq!(
        err.payload.as_deref(),
        Some(&ErrorPayload::StashConflict {
            paths: vec!["src.txt".into()],
            stash_sha: stash,
            checked_out: true
        })
    );
    assert_eq!(env.head_branch(), "other");
    assert_eq!(env.stash_count(), 1);
    assert!(env.read("src.txt").unwrap().contains("<<<<<<<"));
    assert!(env.status().contains("UU src.txt"));
}

#[test]
fn remote_branch_checkout_creates_a_tracking_branch() {
    let env = env();
    env.fx.git(&["switch", "-q", "-c", "feat/remote"]);
    env.commit("r.txt", "r\n", "remote work");
    env.fx.git(&["push", "-q", "origin", "feat/remote"]);
    env.fx.git(&["switch", "-q", "main"]);
    env.fx.git(&["branch", "-q", "-D", "feat/remote"]);

    let target = CheckoutTarget::Remote {
        name: "origin/feat/remote".into(),
    };
    let result = env
        .repos
        .checkout(env.id, target.clone(), CheckoutMode::Clean)
        .unwrap();
    assert_eq!(result.branch.as_deref(), Some("feat/remote"));
    assert!(result.created);
    assert_eq!(env.head_branch(), "feat/remote");
    assert_eq!(
        env.out(&["rev-parse", "--abbrev-ref", "@{upstream}"]),
        "origin/feat/remote"
    );

    // Existing local branch: checked out, not recreated.
    env.fx.git(&["switch", "-q", "main"]);
    let again = env
        .repos
        .checkout(env.id, target, CheckoutMode::Clean)
        .unwrap();
    assert!(!again.created);
    assert_eq!(env.head_branch(), "feat/remote");
}

/// `feat/remote` at "base", `origin/feat/remote` one commit ahead ("remote work"), on `main`.
fn behind_remote(env: &Env) -> CheckoutTarget {
    env.fx.git(&["switch", "-q", "-c", "feat/remote"]);
    env.commit("base.txt", "base\n", "base");
    env.commit("r.txt", "r\n", "remote work");
    env.fx.git(&["push", "-q", "-u", "origin", "feat/remote"]);
    env.fx.git(&["switch", "-q", "main"]);
    env.fx
        .git(&["branch", "-q", "-f", "feat/remote", "feat/remote~1"]);
    CheckoutTarget::Remote {
        name: "origin/feat/remote".into(),
    }
}

#[test]
fn remote_branch_checkout_fast_forwards_a_local_branch_behind_it() {
    let env = env();
    let target = behind_remote(&env);
    // A local change the fast-forward does not touch is carried along.
    env.write("README.md", "local change\n");
    let result = env
        .repos
        .checkout(env.id, target, CheckoutMode::Carry)
        .unwrap();
    assert_eq!(result.branch.as_deref(), Some("feat/remote"));
    assert!(!result.created);
    assert_eq!(result.fast_forwarded.as_deref(), Some("origin/feat/remote"));
    assert_eq!(env.head_branch(), "feat/remote");
    assert_eq!(env.rev("feat/remote"), env.rev("origin/feat/remote"));
    assert_eq!(env.read("r.txt").as_deref(), Some("r\n"));
    assert_eq!(env.read("README.md").as_deref(), Some("local change\n"));
}

#[test]
fn remote_branch_checkout_fast_forwards_the_current_branch() {
    let env = env();
    let target = behind_remote(&env);
    env.fx.git(&["switch", "-q", "feat/remote"]);
    let result = env
        .repos
        .checkout(env.id, target, CheckoutMode::Clean)
        .unwrap();
    assert_eq!(result.fast_forwarded.as_deref(), Some("origin/feat/remote"));
    assert_eq!(env.rev("HEAD"), env.rev("origin/feat/remote"));
    assert_eq!(env.status(), "");
}

#[test]
fn remote_branch_checkout_with_an_untracked_file_in_the_way_of_the_fast_forward() {
    let env = env();
    let target = behind_remote(&env);
    env.write("r.txt", "mine\n");
    let err = env
        .repos
        .checkout(env.id, target.clone(), CheckoutMode::Clean)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree);
    assert_eq!(
        err.payload.as_deref(),
        Some(&ErrorPayload::DirtyWorktree {
            paths: vec!["r.txt".into()],
            can_carry: false
        })
    );
    assert_eq!(env.read("r.txt").as_deref(), Some("mine\n"));
    // Stashed out of the way, the file comes back on top of the updated branch.
    let result = env
        .repos
        .checkout(env.id, target, CheckoutMode::StashAndPop)
        .unwrap_err();
    assert_eq!(result.code, ErrorCode::StashConflict);
    assert_eq!(env.rev("feat/remote"), env.rev("origin/feat/remote"));
}

#[test]
fn remote_branch_checkout_leaves_a_diverged_local_branch_alone() {
    let env = env();
    let target = behind_remote(&env);
    env.fx.git(&["switch", "-q", "feat/remote"]);
    env.commit("l.txt", "l\n", "local work");
    let local = env.rev("feat/remote");
    env.fx.git(&["switch", "-q", "main"]);
    let result = env
        .repos
        .checkout(env.id, target, CheckoutMode::Clean)
        .unwrap();
    assert_eq!(result.fast_forwarded, None);
    assert_eq!(env.head_branch(), "feat/remote");
    assert_eq!(env.rev("feat/remote"), local);
    assert_eq!(env.read("r.txt"), None);
}

#[test]
fn remote_branch_checkout_with_a_change_in_the_way_of_the_fast_forward() {
    let env = env();
    let target = behind_remote(&env);
    // `r.txt` is untracked here and added by the commit the branch catches up with.
    env.write("r.txt", "mine\n");
    env.fx.git(&["add", "--", "r.txt"]);
    let err = env
        .repos
        .checkout(env.id, target, CheckoutMode::Clean)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree);
    assert_eq!(env.head_branch(), "main");
    assert_ne!(env.rev("feat/remote"), env.rev("origin/feat/remote"));
}

#[test]
fn detached_checkout() {
    let env = env();
    let first = env.rev("HEAD~1");
    let result = env
        .repos
        .checkout(
            env.id,
            CheckoutTarget::Detached {
                rev: first[..10].to_owned(),
            },
            CheckoutMode::Clean,
        )
        .unwrap();
    assert_eq!(result.branch, None);
    assert_eq!(env.rev("HEAD"), first);
    assert_eq!(env.head_branch(), "");
}

#[test]
fn creates_branches_from_every_start() {
    let env = env();
    let first = env.rev("HEAD~1");
    env.repos
        .create_branch(env.id, "from-head", BranchStart::Head, false)
        .unwrap();
    assert_eq!(env.rev("from-head"), env.rev("HEAD"));
    env.repos
        .create_branch(
            env.id,
            "from-commit",
            BranchStart::Commit { sha: first.clone() },
            false,
        )
        .unwrap();
    assert_eq!(env.rev("from-commit"), first);
    env.fx.git(&["tag", "t1", &first]);
    env.repos
        .create_branch(
            env.id,
            "from-tag",
            BranchStart::Ref {
                full_name: "refs/tags/t1".into(),
            },
            true,
        )
        .unwrap();
    assert_eq!(env.head_branch(), "from-tag");
    assert_eq!(env.rev("HEAD"), first);
    env.repos
        .create_branch(
            env.id,
            "from-remote",
            BranchStart::Ref {
                full_name: "refs/remotes/origin/main".into(),
            },
            false,
        )
        .unwrap();
    assert_eq!(
        env.out(&["config", "branch.from-remote.merge"]),
        "refs/heads/main"
    );
    let (c, _) = code(
        env.repos
            .create_branch(env.id, "main", BranchStart::Head, false),
    );
    assert_eq!(c, ErrorCode::RefExists);
    let (c, _) = code(
        env.repos
            .create_branch(env.id, "bad name", BranchStart::Head, false),
    );
    assert_eq!(c, ErrorCode::InvalidRefName);
}

#[test]
fn renames_the_current_branch() {
    let env = env();
    env.repos.rename_branch(env.id, "main", "trunk").unwrap();
    assert_eq!(env.head_branch(), "trunk");
    assert_eq!(env.rev("refs/heads/main"), "");
    assert_eq!(env.out(&["config", "branch.trunk.remote"]), "origin");
    env.fx.git(&["branch", "other"]);
    let (c, _) = code(env.repos.rename_branch(env.id, "trunk", "other"));
    assert_eq!(c, ErrorCode::RefExists);
}

#[test]
fn deleting_an_unmerged_branch_needs_force() {
    let env = env();
    env.other_branch();
    let sha = env.rev("other");
    let request = |force| DeleteBranchRequest {
        name: "other".into(),
        force,
        delete_remote: false,
    };
    let (c, err) = code(env.repos.delete_branch(env.id, request(false)));
    assert_eq!(c, ErrorCode::BranchNotMerged);
    assert_eq!(err.action, Some(ErrorAction::ForceDelete));
    assert_eq!(env.rev("refs/heads/other"), sha);

    let deleted = env.repos.delete_branch(env.id, request(true)).unwrap();
    assert_eq!(deleted.local.full_name, "refs/heads/other");
    assert_eq!(deleted.local.sha, sha);
    assert_eq!(env.rev("refs/heads/other"), "");

    let (c, _) = code(env.repos.delete_branch(
        env.id,
        DeleteBranchRequest {
            name: "main".into(),
            force: true,
            delete_remote: false,
        },
    ));
    assert_eq!(c, ErrorCode::CurrentBranch);
}

#[test]
fn deletes_the_remote_branch_too() {
    let env = env();
    env.fx.git(&["switch", "-q", "-c", "feat/x"]);
    env.fx.git(&["push", "-q", "-u", "origin", "feat/x"]);
    env.fx.git(&["switch", "-q", "main"]);
    let sha = env.rev("feat/x");
    let deleted = env
        .repos
        .delete_branch(
            env.id,
            DeleteBranchRequest {
                name: "feat/x".into(),
                force: false,
                delete_remote: true,
            },
        )
        .unwrap();
    let remote = deleted.remote.unwrap();
    assert_eq!(remote.full_name, "refs/remotes/origin/feat/x");
    assert_eq!(remote.sha, sha);
    assert_eq!(env.rev("refs/remotes/origin/feat/x"), "");
    let origin = env.fx.root.join("origin.git");
    let out = std::process::Command::new("git")
        .args(["branch", "--list", "feat/x"])
        .current_dir(origin)
        .output()
        .unwrap();
    assert!(out.stdout.is_empty());
}

#[test]
fn sets_and_unsets_the_upstream() {
    let env = env();
    env.fx.git(&["branch", "local"]);
    env.repos
        .set_upstream(env.id, "local", "origin/main")
        .unwrap();
    assert_eq!(
        env.out(&["rev-parse", "--abbrev-ref", "local@{upstream}"]),
        "origin/main"
    );
    env.repos.unset_upstream(env.id, "local").unwrap();
    assert_eq!(env.out(&["config", "branch.local.remote"]), "");
    // Already without upstream: nothing to do.
    env.repos.unset_upstream(env.id, "local").unwrap();
    let (c, _) = code(env.repos.set_upstream(env.id, "local", "origin/missing"));
    assert_eq!(c, ErrorCode::RevisionNotFound);
}

#[test]
fn stash_push_options_and_nothing_to_stash() {
    let env = env();
    let (c, _) = code(env.repos.stash_push(
        env.id,
        StashPushRequest {
            message: None,
            include_untracked: false,
            keep_index: false,
        },
    ));
    assert_eq!(c, ErrorCode::NothingToStash);

    env.write("src.txt", "staged\n");
    env.fx.git(&["add", "src.txt"]);
    env.write("README.md", "unstaged\n");
    env.write("new.txt", "untracked\n");
    let entry = env
        .repos
        .stash_push(
            env.id,
            StashPushRequest {
                message: Some("my work".into()),
                include_untracked: true,
                keep_index: true,
            },
        )
        .unwrap();
    assert_eq!(entry.sha, env.rev("stash@{0}"));
    assert_eq!(entry.message, "On main: my work");
    // keep-index: staged change still there; untracked and unstaged stashed.
    assert_eq!(env.status(), "M  src.txt");
    assert_eq!(env.read("new.txt"), None);

    // The untracked files are in the third parent, listed apart in the preview.
    let refs = env.repos.list_refs(env.id).unwrap();
    let untracked = refs.stashes[0]
        .untracked_sha
        .clone()
        .expect("untracked commit");
    assert_eq!(untracked, env.rev("stash@{0}^3"));
    let files = env
        .repos
        .changed_files(
            env.id,
            &DiffTarget::Commits {
                from: None,
                to: untracked,
            },
        )
        .unwrap()
        .files;
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "new.txt");
    // A stash without untracked files has no third parent.
    env.write("README.md", "again\n");
    env.fx.git(&["stash", "-q"]);
    assert_eq!(
        env.repos.list_refs(env.id).unwrap().stashes[0].untracked_sha,
        None
    );
}

#[test]
fn stash_apply_pop_drop() {
    let env = env();
    env.write("README.md", "one\n");
    env.fx.git(&["stash", "-q"]);
    let stash = env.stash(0);
    env.repos.stash_apply(env.id, stash.clone()).unwrap();
    assert_eq!(env.read("README.md").as_deref(), Some("one\n"));
    assert_eq!(env.stash_count(), 1);
    env.fx.git(&["checkout", "-q", "--", "README.md"]);

    let popped = env.repos.stash_pop(env.id, stash.clone()).unwrap();
    assert_eq!(popped.sha, stash.sha);
    assert_eq!(env.stash_count(), 0);
    assert_eq!(env.read("README.md").as_deref(), Some("one\n"));

    env.fx.git(&["stash", "-q"]);
    let stale = StashId {
        index: 0,
        sha: "0".repeat(40),
    };
    assert_eq!(
        code(env.repos.stash_drop(env.id, stale)).0,
        ErrorCode::StaleRefs
    );
    let dropped = env.repos.stash_drop(env.id, env.stash(0)).unwrap();
    assert_eq!(env.stash_count(), 0);
    // The saved SHA is enough to restore the stash (undo).
    env.fx
        .git(&["stash", "store", "-m", &dropped.message, &dropped.sha]);
    assert_eq!(env.rev("stash@{0}"), dropped.sha);
}

#[test]
fn stash_apply_conflict_keeps_the_stash() {
    let env = env();
    env.write("src.txt", "stashed\n");
    env.fx.git(&["stash", "-q"]);
    env.commit("src.txt", "committed\n", "conflicting change");
    let stash = env.stash(0);
    let (c, err) = code(env.repos.stash_pop(env.id, stash.clone()));
    assert_eq!(c, ErrorCode::StashConflict);
    assert!(matches!(
        err.payload.as_deref(),
        Some(ErrorPayload::StashConflict { paths, stash_sha, checked_out: false })
            if paths == &["src.txt"] && *stash_sha == stash.sha
    ));
    assert_eq!(env.stash_count(), 1);
}

#[test]
fn stash_rename_keeps_the_content() {
    let env = env();
    env.write("README.md", "first\n");
    env.fx.git(&["stash", "-q", "-m", "first"]);
    env.write("README.md", "second\n");
    env.fx.git(&["stash", "-q", "-m", "second"]);
    let old = env.stash(1);
    let tree = env.rev("stash@{1}^{tree}");

    let renamed = env
        .repos
        .stash_rename(env.id, old.clone(), "renamed")
        .unwrap();
    assert_eq!(renamed.sha, old.sha);
    assert_eq!(env.stash_count(), 2);
    assert_eq!(env.rev("stash@{0}"), old.sha);
    assert_eq!(env.rev("stash@{0}^{tree}"), tree);
    assert_eq!(
        env.out(&["log", "-g", "-1", "--format=%gs", "refs/stash"]),
        "renamed"
    );
    assert_eq!(
        env.out(&["log", "-g", "--format=%gs", "refs/stash"]),
        "renamed\nOn main: second"
    );
}

#[test]
fn stash_branch_applies_on_the_base() {
    let env = env();
    let base = env.rev("HEAD");
    env.write("README.md", "stashed\n");
    env.fx.git(&["stash", "-q"]);
    env.commit("other.txt", "x\n", "move on");
    env.repos
        .stash_branch(env.id, env.stash(0), "from-stash")
        .unwrap();
    assert_eq!(env.head_branch(), "from-stash");
    assert_eq!(env.rev("HEAD"), base);
    assert_eq!(env.read("README.md").as_deref(), Some("stashed\n"));
    assert_eq!(env.stash_count(), 0);
}

#[test]
fn creates_and_deletes_tags() {
    let env = env();
    let first = env.rev("HEAD~1");
    env.repos
        .create_tag(
            env.id,
            CreateTagRequest {
                name: "v1.0".into(),
                target: first.clone(),
                message: Some("Release 1.0\n\nNotes".into()),
                sign: false,
            },
        )
        .unwrap();
    assert_eq!(env.out(&["cat-file", "-t", "v1.0"]), "tag");
    assert_eq!(env.rev("v1.0^{commit}"), first);
    assert_eq!(
        env.out(&["tag", "-l", "--format=%(contents)", "v1.0"]),
        "Release 1.0\n\nNotes"
    );
    env.repos
        .create_tag(
            env.id,
            CreateTagRequest {
                name: "light".into(),
                target: "HEAD".into(),
                message: Some("  ".into()),
                sign: false,
            },
        )
        .unwrap();
    assert_eq!(env.out(&["cat-file", "-t", "light"]), "commit");
    let (c, _) = code(env.repos.create_tag(
        env.id,
        CreateTagRequest {
            name: "light".into(),
            target: "HEAD".into(),
            message: None,
            sign: false,
        },
    ));
    assert_eq!(c, ErrorCode::RefExists);

    let tag_object = env.rev("refs/tags/v1.0");
    let deleted = env.repos.delete_tag(env.id, "v1.0").unwrap();
    assert_eq!(deleted.sha, tag_object);
    assert_eq!(env.rev("refs/tags/v1.0"), "");
}

#[test]
fn stash_checkout_pop_keeps_the_staged_split() {
    let env = env();
    env.other_branch();
    env.write("README.md", "staged\n");
    env.fx.git(&["add", "README.md"]);
    env.write("README.md", "staged\nunstaged\n");
    env.repos
        .checkout(
            env.id,
            CheckoutTarget::Branch {
                name: "other".into(),
            },
            CheckoutMode::StashAndPop,
        )
        .unwrap();
    assert_eq!(env.status(), "MM README.md");
    assert_eq!(env.out(&["show", ":README.md"]), "staged");
}

#[test]
fn stash_checkout_pop_untracked_clash_keeps_the_stash() {
    let env = env();
    env.fx.git(&["switch", "-q", "-c", "other"]);
    env.commit("u.txt", "tracked on other\n", "add u");
    env.fx.git(&["switch", "-q", "main"]);
    env.write("README.md", "edited\n");
    env.write("u.txt", "mine\n");
    let (c, err) = code(env.repos.checkout(
        env.id,
        CheckoutTarget::Branch {
            name: "other".into(),
        },
        CheckoutMode::StashAndPop,
    ));
    assert_eq!(c, ErrorCode::StashConflict);
    assert!(matches!(
        err.payload.as_deref(),
        Some(ErrorPayload::StashConflict { paths, checked_out: true, .. }) if paths == &["u.txt"]
    ));
    assert_eq!(env.head_branch(), "other");
    assert_eq!(env.stash_count(), 1);
}

#[test]
fn stash_checkout_pop_restores_the_changes_when_the_checkout_fails() {
    let env = env();
    env.other_branch();
    let wt = env.fx.root.join("wt");
    env.fx
        .git(&["worktree", "add", "-q", wt.to_str().unwrap(), "other"]);
    env.write("README.md", "staged\n");
    env.fx.git(&["add", "README.md"]);
    env.write("notes.txt", "untracked\n");
    let before = env.status();
    let result = env.repos.checkout(
        env.id,
        CheckoutTarget::Branch {
            name: "other".into(),
        },
        CheckoutMode::StashAndPop,
    );
    assert!(result.is_err());
    assert_eq!(env.head_branch(), "main");
    assert_eq!(env.status(), before);
    assert_eq!(env.stash_count(), 0);
}

#[test]
fn checkout_refuses_unresolved_conflicts() {
    let env = env();
    env.write("src.txt", "stashed\n");
    env.fx.git(&["stash", "-q"]);
    env.commit("src.txt", "committed\n", "conflicting change");
    let _ = env.out(&["stash", "pop"]);
    env.fx.git(&["branch", "other"]);
    let (c, _) = code(env.repos.checkout(
        env.id,
        CheckoutTarget::Branch {
            name: "other".into(),
        },
        CheckoutMode::StashAndPop,
    ));
    assert_eq!(c, ErrorCode::UnresolvedConflicts);
}

#[test]
fn failed_remote_deletion_still_reports_the_local_one() {
    let env = env();
    env.fx.git(&["switch", "-q", "-c", "feat/x"]);
    env.fx.git(&["push", "-q", "-u", "origin", "feat/x"]);
    env.fx.git(&["switch", "-q", "main"]);
    env.fx
        .git(&["remote", "set-url", "origin", "/nonexistent/origin.git"]);
    let sha = env.rev("feat/x");
    let result = env
        .repos
        .delete_branch(
            env.id,
            DeleteBranchRequest {
                name: "feat/x".into(),
                force: false,
                delete_remote: true,
            },
        )
        .unwrap();
    assert_eq!(result.local.sha, sha);
    assert!(result.remote.is_none());
    assert!(result.remote_error.is_some());
    assert_eq!(env.rev("refs/heads/feat/x"), "");
}

#[test]
fn stale_stash_ids_are_refused() {
    let env = env();
    env.write("README.md", "one\n");
    env.fx.git(&["stash", "-q"]);
    let stale = StashId {
        index: 0,
        sha: "1".repeat(40),
    };
    assert_eq!(
        code(env.repos.stash_apply(env.id, stale.clone())).0,
        ErrorCode::StaleRefs
    );
    assert_eq!(
        code(env.repos.stash_rename(env.id, stale.clone(), "x")).0,
        ErrorCode::StaleRefs
    );
    let out_of_range = StashId {
        index: 5,
        sha: env.rev("stash@{0}"),
    };
    assert_eq!(
        code(env.repos.stash_pop(env.id, out_of_range)).0,
        ErrorCode::StaleRefs
    );
    assert_eq!(env.stash_count(), 1);
}

/// The protected-branch rule covers the remote deletion: a protected branch can still be
/// deleted locally on its own, never on the remote with it.
#[test]
fn a_protected_branch_is_never_deleted_on_the_remote() {
    let env = env();
    env.fx.git(&["switch", "-q", "-c", "release/1"]);
    env.fx.git(&["push", "-q", "-u", "origin", "release/1"]);
    env.fx.git(&["switch", "-q", "main"]);
    let sha = env.rev("release/1");
    let (c, err) = code(env.repos.delete_branch(
        env.id,
        DeleteBranchRequest {
            name: "release/1".into(),
            force: false,
            delete_remote: true,
        },
    ));
    assert_eq!(c, ErrorCode::ProtectedBranchDelete, "{err:?}");
    assert_eq!(env.rev("refs/heads/release/1"), sha, "nothing deleted");
    assert_eq!(env.rev("refs/remotes/origin/release/1"), sha);
    assert!(env.repos.op_history(env.id).unwrap().is_empty());

    let deleted = env
        .repos
        .delete_branch(
            env.id,
            DeleteBranchRequest {
                name: "release/1".into(),
                force: false,
                delete_remote: false,
            },
        )
        .unwrap();
    assert!(deleted.remote.is_none());
    assert_eq!(env.rev("refs/heads/release/1"), "");
    assert_eq!(env.rev("refs/remotes/origin/release/1"), sha);
}
