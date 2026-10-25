//! Fixup commits and autosquash (M7-3, F-147) on temporary repositories: the fixup commit
//! (message, journal entry, undo) and the todo the autosquash plan arranges, `squash!` and
//! `amend!` commits included, checked against what `git rebase -i --autosquash` makes.

mod common;

use std::sync::Arc;

use common::{Fixture, RecordingSink};
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::errors::ErrorCode;
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::ops::types::{AutosquashPlan, JournalOp, RebaseAction, RebaseTodoEntry};
use yaggui_lib::repo::RepoManager;
use yaggui_lib::store::Store;

use RebaseAction::{Fixup, Pick, Squash};

struct Env {
    fx: Fixture,
    repos: Arc<RepoManager>,
    id: u32,
    /// Initial commit of main, before the test commits.
    base: String,
}

/// A `clean` fixture with three local commits: `c1` adds `a.txt`, `c2` adds `b.txt`, `c3`
/// adds `c.txt`.
fn env() -> Env {
    let fx = Fixture::new("clean");
    fx.git(&["config", "user.name", "yaggui Tests"]);
    fx.git(&["config", "user.email", "tests@yaggui.dev"]);
    // Interactive editors that would block or fail: yaggui must never use them.
    fx.git(&["config", "core.editor", "false"]);
    fx.git(&["config", "sequence.editor", "false"]);
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
    let mut env = Env {
        fx,
        repos,
        id,
        base: String::new(),
    };
    env.base = env.rev("HEAD");
    for (path, message) in [
        ("a.txt", "c1: add a"),
        ("b.txt", "c2: add b"),
        ("c.txt", "c3: add c"),
    ] {
        env.commit(path, "1\n", message);
    }
    env
}

impl Env {
    fn write(&self, path: &str, content: &str) {
        std::fs::write(self.fx.repo().join(path), content).unwrap();
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

    /// Stages a change of `path` and commits it as a fixup of `target` through yaggui.
    fn fixup(&self, path: &str, content: &str, target: &str) -> String {
        self.write(path, content);
        self.fx.git(&["add", "-A", "--", path]);
        let target = self.rev(target);
        self.repos.commit_fixup(self.id, target).unwrap().sha
    }

    /// Subjects from the base to HEAD, oldest first.
    fn subjects(&self) -> Vec<String> {
        self.out(&[
            "log",
            "--reverse",
            "--format=%s",
            &format!("{}..HEAD", self.base),
        ])
        .lines()
        .map(str::to_owned)
        .collect()
    }

    fn plan(&self, base: Option<&str>) -> Option<AutosquashPlan> {
        self.repos
            .autosquash_plan(self.id, base.map(|b| self.rev(b)))
            .unwrap()
    }
}

/// The todo as `(subject, action)`.
fn arrangement(plan: &AutosquashPlan) -> Vec<(String, RebaseAction)> {
    plan.todo
        .iter()
        .map(|entry| {
            let commit = plan
                .plan
                .commits
                .iter()
                .find(|c| c.sha == entry.sha)
                .unwrap();
            (commit.summary.clone(), entry.action)
        })
        .collect()
}

fn pair(subject: &str, action: RebaseAction) -> (String, RebaseAction) {
    (subject.to_owned(), action)
}

#[test]
fn fixup_commits_the_staged_changes_with_the_target_subject() {
    let env = env();
    let before = env.rev("HEAD");
    let sha = env.fixup("a.txt", "fixed\n", "HEAD~2");
    assert_eq!(env.rev("HEAD"), sha);
    assert_eq!(env.rev("HEAD~1"), before);
    assert_eq!(env.out(&["log", "-1", "--format=%B"]), "fixup! c1: add a");
    assert_eq!(env.out(&["show", "HEAD:a.txt"]), "fixed");
    assert_eq!(env.out(&["diff", "--cached", "--name-only"]), "");

    // Journaled as a commit: undo puts the changes back in the index.
    let entry = env.repos.undo(env.id).unwrap();
    assert!(
        matches!(&entry.op, JournalOp::Commit { sha: s, summary } if *s == sha && summary == "fixup! c1: add a"),
        "{:?}",
        entry.op
    );
    assert_eq!(env.rev("HEAD"), before);
    assert_eq!(env.out(&["diff", "--cached", "--name-only"]), "a.txt");
    env.repos.redo(env.id).unwrap();
    assert_eq!(env.rev("HEAD"), sha);
}

#[test]
fn fixup_of_a_fixup_chains_the_prefix() {
    let env = env();
    env.fixup("a.txt", "2\n", "HEAD~2");
    env.fixup("a.txt", "3\n", "HEAD");
    assert_eq!(
        env.out(&["log", "-1", "--format=%s"]),
        "fixup! fixup! c1: add a"
    );
}

#[test]
fn fixup_refuses_nothing_staged_and_commits_off_the_branch() {
    let env = env();
    let target = env.rev("HEAD~1");
    let err = env.repos.commit_fixup(env.id, target).unwrap_err();
    assert_eq!(err.code, ErrorCode::NothingToCommit);

    env.fx.git(&["switch", "-q", "-c", "side", "HEAD~1"]);
    env.commit("side.txt", "s\n", "side work");
    let side = env.rev("HEAD");
    env.fx.git(&["switch", "-q", "main"]);
    env.write("a.txt", "x\n");
    env.fx.git(&["add", "a.txt"]);
    let err = env.repos.commit_fixup(env.id, side).unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    assert_eq!(env.subjects().len(), 3, "nothing committed");
}

#[test]
fn plan_moves_fixups_under_their_targets_from_the_oldest_target() {
    let env = env();
    env.fixup("b.txt", "2\n", "HEAD~1");
    env.fixup("a.txt", "2\n", "HEAD~3");
    env.fixup("b.txt", "3\n", "HEAD~1"); // fixup! fixup! c2: add b
    env.commit("d.txt", "1\n", "fixup! nothing like this");

    let plan = env.plan(None).unwrap();
    // The oldest target is c1: the plan starts at its parent.
    assert_eq!(plan.plan.base.sha, env.base);
    assert_eq!(
        arrangement(&plan),
        [
            pair("c1: add a", Pick),
            pair("fixup! c1: add a", Fixup),
            pair("c2: add b", Pick),
            pair("fixup! c2: add b", Fixup),
            pair("fixup! fixup! c2: add b", Fixup),
            pair("c3: add c", Pick),
            pair("fixup! nothing like this", Pick),
        ]
    );
    assert_eq!(plan.fixups, 3);
    assert_eq!(plan.unmatched, [env.rev("HEAD")]);

    // The arranged todo runs as it is: one commit per target, with the fixed content.
    env.repos
        .interactive_rebase(env.id, plan.plan.base.sha.clone(), plan.todo.clone())
        .unwrap();
    assert_eq!(
        env.subjects(),
        [
            "c1: add a",
            "c2: add b",
            "c3: add c",
            "fixup! nothing like this"
        ]
    );
    assert_eq!(env.out(&["show", "HEAD~3:a.txt"]), "2");
    assert_eq!(env.out(&["show", "HEAD~2:b.txt"]), "3");
    assert_eq!(
        env.out(&["log", "-1", "--format=%B", "HEAD~2"]),
        "c2: add b"
    );
    assert!(env.plan(None).is_none(), "nothing left to squash");
}

#[test]
fn plan_starts_at_the_oldest_target_only() {
    let env = env();
    env.fixup("c.txt", "2\n", "HEAD");
    let plan = env.plan(None).unwrap();
    assert_eq!(plan.plan.base.sha, env.rev("HEAD~2"));
    assert_eq!(
        arrangement(&plan),
        [pair("c3: add c", Pick), pair("fixup! c3: add c", Fixup)]
    );
}

#[test]
fn plan_with_a_base_flags_targets_before_it() {
    let env = env();
    env.fixup("a.txt", "2\n", "HEAD~2");
    // The base is c1 itself: its fixup stays a pick, flagged.
    let plan = env.plan(Some("HEAD~3")).unwrap();
    assert_eq!(
        arrangement(&plan),
        [
            pair("c2: add b", Pick),
            pair("c3: add c", Pick),
            pair("fixup! c1: add a", Pick),
        ]
    );
    assert_eq!(plan.fixups, 0);
    assert_eq!(plan.unmatched, [env.rev("HEAD")]);
}

#[test]
fn plan_without_fixups_is_none_and_stops_at_merges() {
    let env = env();
    assert!(env.plan(None).is_none());
    // A fixup whose target is behind a merge cannot be rebased: no plan either.
    env.fx.git(&["switch", "-q", "-c", "side", "HEAD~1"]);
    env.commit("side.txt", "s\n", "side work");
    env.fx.git(&["switch", "-q", "main"]);
    env.fx
        .git(&["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    env.fixup("a.txt", "2\n", "HEAD~1~2");
    assert_eq!(env.out(&["log", "-1", "--format=%s"]), "fixup! c1: add a");
    assert!(env.plan(None).is_none());
}

/// `(message, tree)` of each commit from the base to `rev`, oldest first.
fn history(env: &Env, dir: &std::path::Path, rev: &str) -> Vec<(String, String)> {
    let out = std::process::Command::new("git")
        .args([
            "log",
            "--reverse",
            "--format=%B%x00%T%x01",
            &format!("{}..{rev}", env.base),
        ])
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    String::from_utf8(out.stdout)
        .unwrap()
        .split('\x01')
        .filter_map(|commit| {
            let (message, tree) = commit.split_once('\0')?;
            Some((message.trim().to_owned(), tree.trim().to_owned()))
        })
        .collect()
}

#[test]
fn plan_arranges_squash_and_amend_commits_like_git() {
    let env = env();
    // c1 ← squash!, c2 ← amend! then a squash! of the amend!, c3 ← a fixup! of a squash!.
    env.commit("a.txt", "2\n", "squash! c1: add a\n\nsquash body");
    env.commit(
        "b.txt",
        "2\n",
        "amend! c2: add b\n\nc2: add b, reworded\n\nnew body",
    );
    env.commit("c.txt", "2\n", "fixup! squash! c3: add c");
    env.commit("b.txt", "3\n", "squash! amend! c2: add b\n\nmore on b");

    let plan = env.plan(None).unwrap();
    assert_eq!(plan.plan.base.sha, env.base);
    assert_eq!(
        arrangement(&plan),
        [
            pair("c1: add a", Pick),
            pair("squash! c1: add a", Squash),
            pair("c2: add b", Pick),
            pair("amend! c2: add b", Fixup),
            pair("squash! amend! c2: add b", Squash),
            pair("c3: add c", Pick),
            pair("fixup! squash! c3: add c", Fixup),
        ]
    );
    assert_eq!(plan.fixups, 4);
    assert!(plan.unmatched.is_empty());
    // The `amend!` entry is a `fixup -C`: it carries its message, below its subject.
    let messages: Vec<_> = plan.todo.iter().map(|e| e.message.as_deref()).collect();
    assert_eq!(
        messages,
        [
            None,
            None,
            None,
            Some("c2: add b, reworded\n\nnew body"),
            None,
            None,
            None
        ]
    );

    // What Git makes of the same commits, with the editor accepting each squash message.
    let wt = env.fx.root.join("git-autosquash");
    env.fx.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "by-git",
        wt.to_str().unwrap(),
        "HEAD",
    ]);
    let rebased = std::process::Command::new("git")
        .args(["rebase", "-q", "-i", "--autosquash", &env.base])
        .current_dir(&wt)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .env("GIT_EDITOR", "true")
        .output()
        .unwrap();
    assert!(
        rebased.status.success(),
        "{}",
        String::from_utf8_lossy(&rebased.stderr)
    );

    // The view's default messages for the groups (rebaseModel.ts `preview`): the squash
    // subjects left out, the `amend!` message in place of c2's before the squash adds to it.
    let todo: Vec<RebaseTodoEntry> = plan
        .todo
        .iter()
        .enumerate()
        .map(|(i, entry)| RebaseTodoEntry {
            message: match i {
                1 => Some("c1: add a\n\nsquash body".to_owned()),
                4 => Some("c2: add b, reworded\n\nnew body\n\nmore on b".to_owned()),
                _ => None,
            },
            ..entry.clone()
        })
        .collect();
    env.repos
        .interactive_rebase(env.id, plan.plan.base.sha.clone(), todo)
        .unwrap();
    let ours = history(&env, &env.fx.repo(), "HEAD");
    assert_eq!(ours, history(&env, &env.fx.repo(), "by-git"));
    assert_eq!(
        ours.iter().map(|(m, _)| m.as_str()).collect::<Vec<_>>(),
        [
            "c1: add a\n\nsquash body",
            "c2: add b, reworded\n\nnew body\n\nmore on b",
            "c3: add c"
        ]
    );
    assert!(env.plan(None).is_none(), "nothing left to squash");
}

#[test]
fn amend_alone_replaces_the_message_like_git_fixup_c() {
    let env = env();
    env.commit("b.txt", "2\n", "amend! c2: add b\n\nc2: reworded");
    let plan = env.plan(None).unwrap();
    assert_eq!(
        arrangement(&plan),
        [
            pair("c2: add b", Pick),
            pair("amend! c2: add b", Fixup),
            pair("c3: add c", Pick),
        ]
    );
    // The view sends the `fixup -C` message on the entry that holds it.
    env.repos
        .interactive_rebase(env.id, plan.plan.base.sha.clone(), plan.todo.clone())
        .unwrap();
    assert_eq!(env.subjects(), ["c1: add a", "c2: reworded", "c3: add c"]);
    assert_eq!(env.out(&["show", "HEAD~1:b.txt"]), "2");
}

#[test]
fn plan_matches_a_fixup_by_sha_or_branch_name() {
    let env = env();
    let c1 = env.rev("HEAD~2");
    env.fx.git(&["branch", "topic", "HEAD~1"]);
    env.commit("a.txt", "2\n", &format!("fixup! {}", &c1[..10]));
    env.commit("b.txt", "2\n", "fixup! topic");
    let plan = env.plan(None).unwrap();
    assert_eq!(
        arrangement(&plan),
        [
            pair("c1: add a", Pick),
            pair(&format!("fixup! {}", &c1[..10]), Fixup),
            pair("c2: add b", Pick),
            pair("fixup! topic", Fixup),
            pair("c3: add c", Pick),
        ]
    );
}
