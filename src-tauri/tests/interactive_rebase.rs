//! Interactive rebase (M3-4) on temporary repositories: each test checks the resulting Git
//! state.

mod common;

use std::sync::Arc;

use common::{Fixture, RecordingSink};
use yaggui_lib::events::BackendEvent;
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::errors::{ErrorCode, YagguiError};
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::ops::types::{
    ConflictResolution, HistoryEffect, InteractiveRebaseResult, RebaseAction, RebaseTodoEntry,
};
use yaggui_lib::git::read::state::RepoOperation;
use yaggui_lib::repo::RepoManager;
use yaggui_lib::store::Store;

use RebaseAction::{Drop, Edit, Fixup, Pick, Reword, Squash};

struct Env {
    fx: Fixture,
    sink: Arc<RecordingSink>,
    repos: Arc<RepoManager>,
    id: u32,
    /// Initial commit of main, before the four test commits.
    base: String,
    /// `c1`…`c4`, oldest first.
    commits: Vec<String>,
}

/// A `clean` fixture (`README.md`, `src.txt` on main, pushed to `origin/main`) with four
/// local commits: `c1` adds `a.txt`, `c2` adds `b.txt`, `c3` changes `a.txt`, `c4` adds
/// `c.txt`.
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
        RepoManager::new(Arc::new(git), store, sink.clone())
            .without_watcher()
            .with_backup_dir(fx.root.join("backups")),
    );
    let id = repos.open(&fx.repo_str()).unwrap().id;
    let mut env = Env {
        fx,
        sink,
        repos,
        id,
        base: String::new(),
        commits: Vec::new(),
    };
    env.base = env.rev("HEAD");
    for (path, content, message) in [
        ("a.txt", "a1\n", "c1: add a"),
        ("b.txt", "b1\n", "c2: add b"),
        ("a.txt", "a2\n", "c3: change a"),
        ("c.txt", "c1\n", "c4: add c"),
    ] {
        env.commit(path, content, message);
        let sha = env.rev("HEAD");
        env.commits.push(sha);
    }
    env
}

impl Env {
    fn path(&self, path: &str) -> std::path::PathBuf {
        self.fx.repo().join(path)
    }

    fn write(&self, path: &str, content: &str) {
        std::fs::write(self.path(path), content).unwrap();
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

    fn message(&self, rev: &str) -> String {
        let out = std::process::Command::new("git")
            .args(["log", "-1", "--format=%B", rev])
            .current_dir(self.fx.repo())
            .output()
            .unwrap();
        String::from_utf8(out.stdout).unwrap()
    }

    fn author(&self, rev: &str) -> String {
        self.out(&["log", "-1", "--format=%an <%ae> %ad", "--date=raw", rev])
    }

    fn tree(&self, rev: &str) -> String {
        self.out(&["ls-tree", "-r", "--name-only", rev])
    }

    fn operation(&self) -> Option<RepoOperation> {
        self.repos.state(self.id).unwrap().operation
    }

    fn branch(&self) -> String {
        self.out(&["symbolic-ref", "-q", "--short", "HEAD"])
    }

    /// Entry for `c<n>` (1-based).
    fn entry(&self, n: usize, action: RebaseAction, message: Option<&str>) -> RebaseTodoEntry {
        RebaseTodoEntry {
            sha: self.commits[n - 1].clone(),
            action,
            message: message.map(str::to_owned),
        }
    }

    fn rebase(&self, todo: Vec<RebaseTodoEntry>) -> Result<InteractiveRebaseResult, YagguiError> {
        self.repos
            .interactive_rebase(self.id, self.base.clone(), todo)
    }

    fn all(&self, action: RebaseAction) -> Vec<RebaseTodoEntry> {
        (1..=4).map(|n| self.entry(n, action, None)).collect()
    }
}

fn fails<T: std::fmt::Debug>(result: Result<T, YagguiError>) -> YagguiError {
    result.expect_err("expected an error")
}

#[test]
fn plan_lists_the_range_oldest_first_with_pushed_commits() {
    let env = env();
    let plan = env
        .repos
        .interactive_rebase_plan(env.id, &format!("{}~1", env.base))
        .unwrap();
    assert_eq!(plan.branch, "main");
    assert_eq!(plan.upstream.as_deref(), Some("origin/main"));
    assert_eq!(plan.head, env.rev("HEAD"));
    assert_eq!(plan.base.sha, env.rev(&format!("{}~1", env.base)));
    assert!(!plan.has_merges);
    let summaries: Vec<_> = plan.commits.iter().map(|c| c.summary.as_str()).collect();
    assert_eq!(
        summaries,
        [
            env.out(&["log", "-1", "--format=%s", &env.base]).as_str(),
            "c1: add a",
            "c2: add b",
            "c3: change a",
            "c4: add c"
        ]
    );
    // The fixture's second commit is on origin/main, the four new ones are not.
    let pushed: Vec<_> = plan.commits.iter().map(|c| c.pushed).collect();
    assert_eq!(pushed, [true, false, false, false, false]);
    assert_eq!(plan.pushed, 1);
    let first = &plan.commits[1];
    assert_eq!(first.sha, env.commits[0]);
    assert_eq!(first.author_name, "yaggui Tests");
    assert_eq!(first.author_email, "tests@yaggui.dev");
    assert_eq!(first.message, "c1: add a");
    assert!(first.author_time > 0.0);

    // HEAD itself as base: nothing to rebase.
    let empty = env.repos.interactive_rebase_plan(env.id, "HEAD").unwrap();
    assert!(empty.commits.is_empty());

    // Not an ancestor of HEAD.
    env.fx.git(&["switch", "-q", "-c", "side", &env.base]);
    env.commit("side.txt", "s\n", "side");
    let side = env.rev("side");
    env.fx.git(&["switch", "-q", "main"]);
    let err = fails(env.repos.interactive_rebase_plan(env.id, &side));
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    let err = fails(env.repos.interactive_rebase_plan(env.id, "nope"));
    assert_eq!(err.code, ErrorCode::RevisionNotFound);
}

#[test]
fn plan_flags_merges_and_the_rebase_refuses_them() {
    let env = env();
    env.fx.git(&["switch", "-q", "-c", "side", &env.commits[1]]);
    env.commit("side.txt", "s\n", "side");
    env.fx.git(&["switch", "-q", "main"]);
    env.fx
        .git(&["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    let plan = env
        .repos
        .interactive_rebase_plan(env.id, &env.base)
        .unwrap();
    assert!(plan.has_merges);
    assert!(plan.commits.iter().any(|c| c.merge));
    let todo = plan
        .commits
        .iter()
        .map(|c| RebaseTodoEntry {
            sha: c.sha.clone(),
            action: Pick,
            message: None,
        })
        .collect();
    let head = env.rev("HEAD");
    let err = fails(env.rebase(todo));
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    assert_eq!(env.rev("HEAD"), head);
}

#[test]
fn reorders_and_drops_with_progress() {
    let env = env();
    env.sink.clear();
    let result = env
        .rebase(vec![
            env.entry(2, Pick, None),
            env.entry(4, Pick, None),
            env.entry(1, Pick, None),
            env.entry(3, Drop, None),
        ])
        .unwrap();
    assert_eq!(result.effect, HistoryEffect::Commits);
    assert_eq!(result.previous_head, env.commits[3]);
    assert_eq!(result.head, env.rev("HEAD"));
    assert!(result.stopped.is_none());
    assert_eq!(env.operation(), None);
    assert_eq!(env.branch(), "main");
    assert_eq!(env.subjects(), ["c2: add b", "c4: add c", "c1: add a"]);
    assert_eq!(env.read("a.txt").as_deref(), Some("a1\n"));
    assert_eq!(env.out(&["status", "--porcelain"]), "");
    let steps: Vec<_> = env
        .sink
        .events()
        .into_iter()
        .filter_map(|e| match e {
            BackendEvent::OpProgress(p) if p.phase == "Rebasing" => Some((p.current, p.total)),
            _ => None,
        })
        .collect();
    assert!(steps.contains(&(Some(4), Some(4))), "{steps:?}");

    // Same order, everything picked: nothing moves.
    let head = env.rev("HEAD");
    let plan = env
        .repos
        .interactive_rebase_plan(env.id, &env.base)
        .unwrap();
    let todo = plan
        .commits
        .iter()
        .map(|c| RebaseTodoEntry {
            sha: c.sha.clone(),
            action: Pick,
            message: None,
        })
        .collect();
    let same = env.rebase(todo).unwrap();
    assert_eq!(same.effect, HistoryEffect::UpToDate);
    assert_eq!(env.rev("HEAD"), head);
}

#[test]
fn reword_keeps_content_and_author_with_special_characters() {
    let env = env();
    let message = "c2: \"quoted\" $HOME `id` 'single' \\ é 🌳\n\n# not a comment\n#also kept\n\tindented; rm -rf / && echo\n";
    env.rebase(vec![
        env.entry(1, Pick, None),
        env.entry(2, Reword, Some(message)),
        env.entry(3, Pick, None),
        env.entry(4, Pick, None),
    ])
    .unwrap();
    assert_eq!(env.message("HEAD~2"), format!("{message}\n"));
    assert_eq!(env.author("HEAD~2"), env.author(&env.commits[1]));
    assert_eq!(env.tree("HEAD"), env.tree(&env.commits[3]));
    assert_eq!(
        env.rev("HEAD^{tree}"),
        env.rev(&format!("{}^{{tree}}", env.commits[3]))
    );
    // The commit before is untouched (fast-forwarded).
    assert_eq!(env.rev("HEAD~3"), env.commits[0]);
}

#[test]
fn squash_takes_the_given_message_and_fixup_keeps_the_target_one() {
    let env = env();
    let squashed = "c1+c3: a, final\n\n# kept line\nbody";
    env.rebase(vec![
        env.entry(1, Pick, None),
        env.entry(3, Squash, Some(squashed)),
        env.entry(2, Pick, None),
        env.entry(4, Fixup, None),
    ])
    .unwrap();
    assert_eq!(env.subjects(), ["c1+c3: a, final", "c2: add b"]);
    assert_eq!(env.message("HEAD~1"), format!("{squashed}\n\n"));
    assert_eq!(env.message("HEAD"), "c2: add b\n\n");
    // c1 and c3 melded: a.txt created with its final content.
    assert_eq!(env.out(&["show", "HEAD~1:a.txt"]), "a2");
    assert_eq!(
        env.out(&["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]),
        "b.txt\nc.txt"
    );
    assert_eq!(env.author("HEAD~1"), env.author(&env.commits[0]));
}

#[test]
fn edit_stops_then_amend_and_continue() {
    let env = env();
    let result = env
        .rebase(vec![
            env.entry(1, Pick, None),
            env.entry(2, Edit, None),
            env.entry(3, Pick, None),
            env.entry(4, Pick, None),
        ])
        .unwrap();
    let stop = result.stopped.expect("stopped on edit");
    assert_eq!(stop.commit.summary, "c2: add b");
    assert_eq!(stop.commit.sha, env.rev("HEAD"));
    assert_eq!((stop.step, stop.total), (Some(2), Some(4)));
    match env.operation() {
        Some(RepoOperation::Rebase {
            step,
            total,
            head_name,
            ..
        }) => {
            assert_eq!((step, total), (Some(2), Some(4)));
            assert_eq!(head_name.as_deref(), Some("main"));
        }
        other => panic!("{other:?}"),
    }
    // Anything else is refused while it is in progress.
    let err = fails(env.rebase(env.all(Pick)));
    assert_eq!(err.code, ErrorCode::OperationInProgress);

    // Amend the stopped commit, then continue.
    env.write("b.txt", "b1 edited\n");
    env.repos
        .stage_paths(
            env.id,
            yaggui_lib::git::ops::types::PathSelection::Paths {
                paths: vec!["b.txt".into()],
            },
        )
        .unwrap();
    env.repos
        .commit(
            env.id,
            yaggui_lib::git::ops::types::CommitRequest {
                summary: "c2: add b, edited".into(),
                description: String::new(),
                amend: true,
                skip_hooks: false,
            },
        )
        .unwrap();
    let done = env.repos.continue_operation(env.id, None).unwrap();
    assert_eq!(done.effect, HistoryEffect::Commits);
    assert_eq!(env.operation(), None);
    assert_eq!(env.branch(), "main");
    assert_eq!(
        env.subjects(),
        [
            "c1: add a",
            "c2: add b, edited",
            "c3: change a",
            "c4: add c"
        ]
    );
    assert_eq!(env.out(&["show", "HEAD:b.txt"]), "b1 edited");
}

#[test]
fn edit_stop_then_abort_restores_the_branch() {
    let env = env();
    let head = env.rev("HEAD");
    let result = env
        .rebase(vec![
            env.entry(1, Edit, None),
            env.entry(2, Drop, None),
            env.entry(3, Pick, None),
            env.entry(4, Pick, None),
        ])
        .unwrap();
    assert_eq!(result.stopped.unwrap().step, Some(1));
    env.repos.abort_operation(env.id).unwrap();
    assert_eq!(env.operation(), None);
    assert_eq!(env.branch(), "main");
    assert_eq!(env.rev("HEAD"), head);
}

#[test]
fn conflict_stops_then_continues_or_aborts() {
    let env = env();
    let head = env.rev("HEAD");
    // c3 changes a.txt before c1 creates it: modify/delete conflict on the first step.
    let todo = || {
        vec![
            env.entry(3, Pick, None),
            env.entry(1, Pick, None),
            env.entry(2, Pick, None),
            env.entry(4, Pick, None),
        ]
    };
    let err = fails(env.rebase(todo()));
    assert_eq!(err.code, ErrorCode::Conflicts, "{err:?}");
    match env.operation() {
        Some(RepoOperation::Rebase { step, total, .. }) => {
            assert_eq!((step, total), (Some(1), Some(4)));
        }
        other => panic!("{other:?}"),
    }

    // Abort: back where it was.
    env.repos.abort_operation(env.id).unwrap();
    assert_eq!(env.operation(), None);
    assert_eq!(env.rev("HEAD"), head);
    assert_eq!(env.branch(), "main");

    // Again, keep their side (a2), then c1 conflicts (add/add): keep theirs (a1) too.
    fails(env.rebase(todo()));
    env.repos
        .resolve_conflicts(env.id, vec!["a.txt".into()], ConflictResolution::Theirs)
        .unwrap();
    let again = fails(env.repos.continue_operation(env.id, None));
    assert_eq!(again.code, ErrorCode::Conflicts, "{again:?}");
    env.repos
        .resolve_conflicts(env.id, vec!["a.txt".into()], ConflictResolution::Theirs)
        .unwrap();
    env.repos.continue_operation(env.id, None).unwrap();
    assert_eq!(env.operation(), None);
    assert_eq!(
        env.subjects(),
        ["c3: change a", "c1: add a", "c2: add b", "c4: add c"]
    );
    assert_eq!(env.read("a.txt").as_deref(), Some("a1\n"));
}

#[test]
fn squash_message_survives_a_conflict() {
    let env = env();
    // c3 melded into c2 conflicts (a.txt missing); the combined message must still be the
    // given one, `#` lines included, after continue.
    let message = "b and a\n\n# heading kept\nend";
    let err = fails(env.rebase(vec![
        env.entry(2, Pick, None),
        env.entry(3, Squash, Some(message)),
        env.entry(1, Drop, None),
        env.entry(4, Pick, None),
    ]));
    assert_eq!(err.code, ErrorCode::Conflicts, "{err:?}");
    env.repos
        .resolve_conflicts(env.id, vec!["a.txt".into()], ConflictResolution::Theirs)
        .unwrap();
    env.repos.continue_operation(env.id, None).unwrap();
    assert_eq!(env.operation(), None);
    assert_eq!(env.subjects(), ["b and a", "c4: add c"]);
    assert_eq!(env.message("HEAD~1"), format!("{message}\n\n"));
    assert_eq!(env.out(&["show", "HEAD~1:a.txt"]), "a2");
}

#[test]
fn skip_on_a_conflict_drops_that_commit() {
    let env = env();
    fails(env.rebase(vec![
        env.entry(3, Pick, None),
        env.entry(1, Pick, None),
        env.entry(2, Pick, None),
        env.entry(4, Pick, None),
    ]));
    env.repos.skip_operation(env.id).unwrap();
    assert_eq!(env.operation(), None);
    assert_eq!(env.subjects(), ["c1: add a", "c2: add b", "c4: add c"]);
}

#[test]
fn refuses_invalid_todos_and_dirty_trees() {
    let env = env();
    let head = env.rev("HEAD");
    let code = |todo| fails(env.rebase(todo)).code;
    // Squash first, missing commit, unknown commit, reword without message.
    assert_eq!(
        code(vec![
            env.entry(1, Squash, Some("x")),
            env.entry(2, Pick, None),
            env.entry(3, Pick, None),
            env.entry(4, Pick, None),
        ]),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        code(env.all(Pick).into_iter().take(3).collect()),
        ErrorCode::InvalidArgument
    );
    let mut unknown = env.all(Pick);
    unknown[0].sha = env.base.clone();
    assert_eq!(code(unknown), ErrorCode::InvalidArgument);
    let mut reword = env.all(Pick);
    reword[1].action = Reword;
    assert_eq!(code(reword), ErrorCode::InvalidArgument);
    assert_eq!(code(env.all(Drop)), ErrorCode::InvalidArgument);
    assert_eq!(env.rev("HEAD"), head);

    // Tracked changes: refused before anything happens. Untracked files are fine.
    env.write("a.txt", "dirty\n");
    let err = fails(env.rebase(env.all(Pick)));
    assert_eq!(err.code, ErrorCode::DirtyWorktree);
    env.fx.git(&["checkout", "-q", "--", "a.txt"]);
    env.write("untracked.txt", "u\n");
    env.rebase(vec![
        env.entry(1, Pick, None),
        env.entry(2, Pick, None),
        env.entry(4, Pick, None),
        env.entry(3, Drop, None),
    ])
    .unwrap();
    assert_eq!(env.subjects(), ["c1: add a", "c2: add b", "c4: add c"]);

    // Detached HEAD.
    env.fx.git(&["switch", "-q", "--detach", "HEAD"]);
    let err = fails(env.repos.interactive_rebase_plan(env.id, &env.base));
    assert_eq!(err.code, ErrorCode::DetachedHead);
}

#[test]
fn reword_head_amends_the_message_only() {
    let env = env();
    // Staged and unstaged changes stay where they are.
    env.write("a.txt", "staged\n");
    env.fx.git(&["add", "--", "a.txt"]);
    env.write("b.txt", "unstaged\n");
    let before = env.rev("HEAD");
    let result = env
        .repos
        .reword_commit(env.id, before.clone(), "c4: new\n\nbody".to_owned())
        .unwrap();
    assert_eq!(result.sha, env.rev("HEAD"));
    assert_ne!(result.sha, before);
    assert_eq!(env.message("HEAD"), "c4: new\n\nbody\n\n");
    assert_eq!(
        env.rev("HEAD^{tree}"),
        env.rev(&format!("{before}^{{tree}}"))
    );
    assert_eq!(env.rev("HEAD^"), env.commits[2]);
    assert_eq!(env.out(&["diff", "--cached", "--name-only"]), "a.txt");
    assert_eq!(env.out(&["diff", "--name-only"]), "b.txt");

    // Undoable like an amend.
    env.repos.undo(env.id).unwrap();
    assert_eq!(env.rev("HEAD"), before);
}

#[test]
fn reword_older_commit_replays_the_ones_after_it() {
    let env = env();
    let result = env
        .repos
        .reword_commit(env.id, env.commits[1].clone(), "c2: reworded".to_owned())
        .unwrap();
    assert_eq!(
        env.subjects(),
        ["c1: add a", "c2: reworded", "c3: change a", "c4: add c"]
    );
    assert_eq!(result.sha, env.rev("HEAD~2"));
    assert_eq!(env.rev("HEAD~3"), env.commits[0]);
    assert_eq!(env.author("HEAD~2"), env.author(&env.commits[1]));
    assert_eq!(
        env.rev("HEAD^{tree}"),
        env.rev(&format!("{}^{{tree}}", env.commits[3]))
    );
    assert_eq!(env.branch(), "main");
    assert!(env.operation().is_none());
}

#[test]
fn reword_refuses_what_it_cannot_rewrite() {
    let env = env();
    let head = env.rev("HEAD");
    let code = |sha: &str, message: &str| {
        fails(
            env.repos
                .reword_commit(env.id, sha.to_owned(), message.to_owned()),
        )
        .code
    };
    assert_eq!(code(&head, "  \n\nbody"), ErrorCode::InvalidArgument);
    // Root commit, not HEAD.
    let root = env.out(&["rev-list", "--max-parents=0", "HEAD"]);
    assert_eq!(code(&root, "root"), ErrorCode::InvalidArgument);
    // Not on the current branch.
    env.fx
        .git(&["checkout", "-q", "-b", "side", &env.commits[1]]);
    env.commit("side.txt", "s\n", "side");
    let side = env.rev("HEAD");
    env.fx.git(&["checkout", "-q", "main"]);
    assert_eq!(code(&side, "x"), ErrorCode::InvalidArgument);
    // Tracked changes block a rebase.
    env.write("a.txt", "dirty\n");
    assert_eq!(code(&env.commits[1], "x"), ErrorCode::DirtyWorktree);
    assert_eq!(env.rev("HEAD"), head);
}
