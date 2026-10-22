//! Persistent undo journal (M7-1, F-244): the journal of a repository is saved in `yaggui.db`
//! and reloaded when it opens again. A restart is simulated by closing the repository and
//! building a new backend on the same database file.

mod common;

use std::path::PathBuf;
use std::sync::Arc;

use common::{Fixture, RecordingSink};
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::errors::{ErrorCode, ErrorPayload};
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::ops::types::{
    BranchStart, CommitRequest, DeleteBranchRequest, JournalOp, PathSelection, StashFileRequest,
    StashId, UndoBlock,
};
use yaggui_lib::repo::RepoManager;
use yaggui_lib::store::{JOURNAL_MAX_AGE_DAYS, Store, StoredJournalRow};

struct Env {
    fx: Fixture,
    db: PathBuf,
    store: Arc<Store>,
    repos: RepoManager,
    id: u32,
}

fn backend(fx: &Fixture, store: Arc<Store>) -> RepoManager {
    let sink = Arc::new(RecordingSink::default());
    let git = GitCli::new(Arc::new(CommandLog::new()), sink.clone())
        .with_env("GIT_CONFIG_NOSYSTEM", "1")
        .with_env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        );
    RepoManager::new(Arc::new(git), store, sink)
        .without_watcher()
        .with_backup_dir(fx.root.join("backups"))
}

fn env() -> Env {
    let fx = Fixture::new("clean");
    fx.git(&["config", "user.name", "yaggui Tests"]);
    fx.git(&["config", "user.email", "tests@yaggui.dev"]);
    let db = fx.root.join("config").join("yaggui.db");
    let store = Arc::new(Store::open(&db).unwrap());
    let repos = backend(&fx, Arc::clone(&store));
    let id = repos.open(&fx.repo_str()).unwrap().id;
    Env {
        fx,
        db,
        store,
        repos,
        id,
    }
}

impl Env {
    /// Closes the repository, then opens it again in a new backend on the same database.
    /// `while_closed` runs in between (changes made outside yaggui).
    fn restart(&mut self, while_closed: impl FnOnce(&Fixture)) {
        self.repos.close(self.id);
        while_closed(&self.fx);
        self.store = Arc::new(Store::open(&self.db).unwrap());
        self.repos = backend(&self.fx, Arc::clone(&self.store));
        let id = self.repos.open(&self.fx.repo_str()).unwrap().id;
        assert_eq!(id, self.id, "same repository, same id");
    }

    fn out(&self, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(self.fx.repo())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .output()
            .unwrap();
        String::from_utf8(out.stdout).unwrap().trim().to_owned()
    }

    /// Refs, HEAD, index and status: what an undo changes.
    fn state(&self) -> String {
        [
            self.out(&["for-each-ref", "--format=%(refname) %(objectname)"]),
            self.out(&["rev-parse", "HEAD"]),
            self.out(&["ls-files", "-s"]),
            self.out(&["status", "--porcelain", "--untracked-files=all"]),
        ]
        .join("\n")
    }

    fn write(&self, path: &str, content: &str) {
        std::fs::write(self.fx.repo().join(path), content).unwrap();
    }

    fn read(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(self.fx.repo().join(path)).ok()
    }

    fn commit(&self, summary: &str) {
        self.repos
            .commit(
                self.id,
                CommitRequest {
                    summary: summary.into(),
                    description: String::new(),
                    amend: false,
                    skip_hooks: true,
                },
            )
            .unwrap();
    }

    fn undo_error(&self) -> (ErrorCode, Option<ErrorPayload>) {
        let err = self.repos.undo(self.id).unwrap_err();
        (err.code, err.payload.map(|p| *p))
    }
}

#[test]
fn commit_is_undone_after_a_restart() {
    let mut e = env();
    e.write("new.txt", "new\n");
    e.fx.git(&["add", "new.txt"]);
    let before = e.state();
    e.commit("add new");
    let after = e.state();

    e.restart(|_| {});
    let history = e.repos.op_history(e.id).unwrap();
    assert_eq!(history.len(), 1);
    assert!(history[0].restored);
    assert!(matches!(&history[0].op, JournalOp::Commit { summary, .. } if summary == "add new"));
    let state = e.repos.undo_state(e.id).unwrap();
    assert_eq!(state.undo.map(|s| s.blocked), Some(None));

    let entry = e.repos.undo(e.id).unwrap();
    assert!(entry.undone && entry.restored);
    assert_eq!(e.state(), before);

    // The undone position is saved too: the redo survives another restart.
    e.restart(|_| {});
    e.repos.redo(e.id).unwrap();
    assert_eq!(e.state(), after);
}

#[test]
fn new_entries_follow_the_restored_ones() {
    let mut e = env();
    e.repos
        .create_branch(e.id, "one", BranchStart::Head, false)
        .unwrap();
    e.restart(|_| {});
    e.repos
        .create_branch(e.id, "two", BranchStart::Head, false)
        .unwrap();
    let history = e.repos.op_history(e.id).unwrap();
    let ids: Vec<(u32, bool)> = history.iter().map(|h| (h.id, h.restored)).collect();
    assert_eq!(ids, vec![(2, false), (1, true)]);
    e.repos.undo(e.id).unwrap();
    e.repos.undo(e.id).unwrap();
    assert_eq!(e.out(&["branch", "--list", "one", "two"]), "");
}

#[test]
fn branch_deletion_is_undone_after_a_restart() {
    let mut e = env();
    e.fx.git(&["branch", "--track", "old", "origin/main"]);
    let before = e.state();
    let upstream = e.out(&["config", "branch.old.merge"]);
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
    e.restart(|_| {});
    e.repos.undo(e.id).unwrap();
    assert_eq!(e.state(), before);
    assert_eq!(e.out(&["config", "branch.old.merge"]), upstream);
}

#[test]
fn discard_is_undone_after_a_restart() {
    let mut e = env();
    e.write("src.txt", "modified before the discard\n");
    e.write("untracked.txt", "untracked before the discard\n");
    let before = e.state();
    e.repos
        .discard_paths(
            e.id,
            PathSelection::Paths {
                paths: vec!["src.txt".into(), "untracked.txt".into()],
            },
            false,
        )
        .unwrap();
    assert_eq!(e.read("untracked.txt"), None);
    e.restart(|_| {});
    e.repos.undo(e.id).unwrap();
    assert_eq!(e.state(), before);
    assert_eq!(
        e.read("untracked.txt").as_deref(),
        Some("untracked before the discard\n")
    );
    assert_eq!(
        e.read("src.txt").as_deref(),
        Some("modified before the discard\n")
    );
}

/// M7-10: the writes added in M7 restore like the M4 ones (F-147, F-185).
#[test]
fn fixup_commit_is_undone_after_a_restart() {
    let mut e = env();
    e.write("new.txt", "new\n");
    e.fx.git(&["add", "new.txt"]);
    e.commit("add new");
    let target = e.out(&["rev-parse", "HEAD"]);
    e.write("new.txt", "new, fixed\n");
    e.fx.git(&["add", "new.txt"]);
    let before = e.state();
    e.repos.commit_fixup(e.id, target).unwrap();
    let after = e.state();

    e.restart(|_| {});
    let history = e.repos.op_history(e.id).unwrap();
    assert!(history[0].restored);
    assert!(
        matches!(&history[0].op, JournalOp::Commit { summary, .. } if summary == "fixup! add new")
    );
    e.repos.undo(e.id).unwrap();
    assert_eq!(e.state(), before, "fixup undone, the change staged again");
    e.restart(|_| {});
    e.repos.redo(e.id).unwrap();
    assert_eq!(e.state(), after);
}

#[test]
fn stash_file_apply_is_undone_after_a_restart() {
    let mut e = env();
    e.write("src.txt", "1\n2\n3\n4\n5\n");
    e.fx.git(&["commit", "-qam", "five lines"]);
    e.write("src.txt", "1\nstashed\n3\n4\n5\n");
    e.write("README.md", "# Stashed\n");
    e.fx.git(&["stash", "-q"]);
    // Committed since the stash, elsewhere in the file: merged, and backed up for the undo.
    e.write("src.txt", "1\n2\n3\n4\nfive\n");
    e.fx.git(&["commit", "-qam", "change line 5"]);
    let before = e.state();
    let stashes = e.out(&["stash", "list", "--format=%H"]);
    e.repos
        .stash_apply_file(
            e.id,
            StashFileRequest {
                stash: StashId {
                    index: 0,
                    sha: e.out(&["rev-parse", "stash@{0}"]),
                },
                path: "src.txt".into(),
                untracked: false,
            },
        )
        .unwrap();
    assert_eq!(
        e.read("src.txt").as_deref(),
        Some("1\nstashed\n3\n4\nfive\n")
    );

    e.restart(|_| {});
    let history = e.repos.op_history(e.id).unwrap();
    assert!(history[0].restored);
    assert!(matches!(&history[0].op, JournalOp::StashApplyFile { path, .. } if path == "src.txt"));
    e.repos.undo(e.id).unwrap();
    assert_eq!(e.state(), before);
    assert_eq!(
        e.read("src.txt").as_deref(),
        Some("1\n2\n3\n4\nfive\n"),
        "the backed-up file comes back"
    );
    assert_eq!(e.out(&["stash", "list", "--format=%H"]), stashes);
}

#[test]
fn refs_moved_while_closed_are_refused_as_diverged() {
    let mut e = env();
    e.write("new.txt", "new\n");
    e.fx.git(&["add", "new.txt"]);
    e.commit("add new");
    e.restart(|fx| {
        fx.git(&["commit", "-q", "--allow-empty", "-m", "outside yaggui"]);
    });
    let state = e.repos.undo_state(e.id).unwrap();
    assert!(matches!(
        state.undo.and_then(|s| s.blocked),
        Some(UndoBlock::Diverged { refs }) if refs.contains(&"refs/heads/main".to_owned())
    ));
    let before = e.state();
    let (code, payload) = e.undo_error();
    assert_eq!(code, ErrorCode::UndoDiverged);
    assert!(
        matches!(payload, Some(ErrorPayload::UndoChanges { refs, .. }) if refs.contains(&"refs/heads/main".to_owned()))
    );
    assert_eq!(e.state(), before, "nothing changed");
}

#[test]
fn pruned_backup_is_refused_as_objects_missing() {
    let mut e = env();
    e.write("src.txt", "only in the discarded change\n");
    e.write("untracked.txt", "only in the discarded file\n");
    e.repos
        .discard_paths(
            e.id,
            PathSelection::Paths {
                paths: vec!["src.txt".into(), "untracked.txt".into()],
            },
            false,
        )
        .unwrap();
    e.restart(|fx| {
        fx.git(&["reflog", "expire", "--expire=now", "--all"]);
        fx.git(&["gc", "-q", "--prune=now"]);
    });
    let before = e.state();

    let expected = UndoBlock::ObjectsMissing { count: 2 };
    let history = e.repos.op_history(e.id).unwrap();
    assert_eq!(history[0].blocked, Some(expected.clone()));
    let state = e.repos.undo_state(e.id).unwrap();
    assert_eq!(state.undo.and_then(|s| s.blocked), Some(expected.clone()));

    let (code, payload) = e.undo_error();
    assert_eq!(code, ErrorCode::UndoObjectsMissing);
    assert_eq!(
        payload,
        Some(ErrorPayload::UndoBlocked { reason: expected })
    );
    assert_eq!(e.state(), before, "nothing changed");
    assert_eq!(e.read("untracked.txt"), None);
    let undone = e.repos.op_history(e.id).unwrap();
    assert!(!undone[0].undone, "still not undone");
}

#[test]
fn pruned_commit_is_refused_as_objects_missing() {
    let mut e = env();
    e.write("new.txt", "a commit that only this undo knows\n");
    e.fx.git(&["add", "new.txt"]);
    e.commit("add new");
    e.repos.undo(e.id).unwrap();
    e.restart(|fx| {
        fx.git(&["reflog", "expire", "--expire=now", "--all"]);
        fx.git(&["gc", "-q", "--prune=now"]);
    });
    let before = e.state();
    let err = e.repos.redo(e.id).unwrap_err();
    assert_eq!(err.code, ErrorCode::UndoObjectsMissing);
    assert_eq!(e.state(), before, "nothing changed");
}

#[test]
fn entries_older_than_the_bound_are_dropped_on_open() {
    let mut e = env();
    e.repos
        .create_branch(e.id, "recent", BranchStart::Head, false)
        .unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let old = StoredJournalRow {
        seq: 0,
        at: now - i64::from(JOURNAL_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000,
        undone: false,
        redo_order: None,
        entry:
            r#"{"id":0,"op":{"kind":"pull"},"at":0,"undone":false,"blocked":null,"restored":false}"#
                .into(),
        format: 1,
        state: "{}".into(),
    };
    // Written with an old clock, so the save itself keeps it.
    e.store.append_journal(e.id, &old, old.at).unwrap();
    e.restart(|_| {});
    let history = e.repos.op_history(e.id).unwrap();
    assert_eq!(history.len(), 1);
    assert!(matches!(&history[0].op, JournalOp::CreateBranch { name } if name == "recent"));
}

#[test]
fn unreadable_entries_are_kept_but_blocked() {
    let e = env();
    e.repos
        .create_branch(e.id, "topic", BranchStart::Head, false)
        .unwrap();
    e.repos.close(e.id);
    let mut e = env_with_rows(e, |row| row.format = 99);
    let history = e.repos.op_history(e.id).unwrap();
    assert_eq!(history[0].blocked, Some(UndoBlock::Unreadable));
    let (code, _) = e.undo_error();
    assert_eq!(code, ErrorCode::UndoBlocked);
    assert_eq!(e.out(&["branch", "--list", "topic"]), "topic");
    e.restart(|_| {});
}

/// Reopens `e` after rewriting its saved rows with `edit`.
fn env_with_rows(mut e: Env, edit: impl Fn(&mut StoredJournalRow)) -> Env {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    for mut row in e.store.load_journal(e.id, now).unwrap() {
        edit(&mut row);
        e.store.append_journal(e.id, &row, now).unwrap();
    }
    e.store = Arc::new(Store::open(&e.db).unwrap());
    e.repos = backend(&e.fx, Arc::clone(&e.store));
    let id = e.repos.open(&e.fx.repo_str()).unwrap().id;
    assert_eq!(id, e.id);
    e
}

#[test]
fn journal_is_dropped_with_the_repository() {
    let mut e = env();
    e.repos
        .create_branch(e.id, "topic", BranchStart::Head, false)
        .unwrap();
    e.repos.close_all(e.id);
    e.store.forget_repo(e.id).unwrap();
    let old = e.id;
    e.store = Arc::new(Store::open(&e.db).unwrap());
    e.repos = backend(&e.fx, Arc::clone(&e.store));
    e.id = e.repos.open(&e.fx.repo_str()).unwrap().id;
    assert!(e.repos.op_history(e.id).unwrap().is_empty());
    assert!(e.store.load_journal(old, 0).unwrap().is_empty());
}
