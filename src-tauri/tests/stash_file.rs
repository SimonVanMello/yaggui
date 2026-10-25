//! One file applied from a stash (F-185) on temporary repositories: the resulting working
//! tree and index, the stash left untouched, and the undo putting the previous file back.

mod common;

use std::sync::Arc;

use common::{Fixture, RecordingSink};
use yaggui_lib::events::{BackendEvent, OpKind, OpOutcome};
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::errors::{ErrorCode, ErrorPayload, YagguiError};
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::ops::types::{JournalOp, StashFileRequest, StashId};
use yaggui_lib::repo::RepoManager;
use yaggui_lib::store::Store;

struct Env {
    fx: Fixture,
    repos: Arc<RepoManager>,
    id: u32,
    sink: Arc<RecordingSink>,
}

/// A `clean` fixture (`README.md`, `src.txt` committed) opened by an isolated backend.
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
        repos,
        id,
        sink,
    }
}

const LINES: &str = "1\n2\n3\n4\n5\n";

impl Env {
    fn write(&self, path: &str, content: impl AsRef<[u8]>) {
        std::fs::write(self.fx.repo().join(path), content).unwrap();
    }

    fn read(&self, path: &str) -> Option<Vec<u8>> {
        std::fs::read(self.fx.repo().join(path)).ok()
    }

    fn text(&self, path: &str) -> Option<String> {
        self.read(path).map(|b| String::from_utf8(b).unwrap())
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
        String::from_utf8(out.stdout).unwrap().trim_end().to_owned()
    }

    fn commit(&self, path: &str, content: impl AsRef<[u8]>, message: &str) {
        self.write(path, content);
        self.fx.git(&["add", "--", path]);
        self.fx.git(&["commit", "-q", "-m", message]);
    }

    fn status(&self) -> String {
        self.out(&["status", "--porcelain=v1", "--untracked-files=all"])
    }

    /// Index entries with their stages, and the stash list with its commits.
    fn index(&self) -> String {
        self.out(&["ls-files", "-s"])
    }

    fn stashes(&self) -> String {
        self.out(&["stash", "list", "--format=%H %gs"])
    }

    fn stash(&self, index: u32) -> StashId {
        StashId {
            index,
            sha: self.out(&["rev-parse", &format!("stash@{{{index}}}")]),
        }
    }

    fn apply(&self, path: &str, untracked: bool) -> Result<(), YagguiError> {
        self.repos.stash_apply_file(
            self.id,
            StashFileRequest {
                stash: self.stash(0),
                path: path.to_owned(),
                untracked,
            },
        )
    }

    /// `src.txt` holding five lines, then a stash changing line 2 of it and `README.md`.
    fn stash_line_two(&self) {
        self.commit("src.txt", LINES, "five lines");
        self.write("src.txt", "1\nstashed\n3\n4\n5\n");
        self.write("README.md", "# Stashed\n");
        self.fx.git(&["stash", "-q"]);
    }
}

fn error(result: Result<(), YagguiError>) -> YagguiError {
    result.expect_err("expected an error")
}

#[test]
fn a_tracked_file_is_merged_unstaged_and_the_stash_is_kept() {
    let e = env();
    e.stash_line_two();
    // A change committed since the stash, elsewhere in the file: merged, not overwritten.
    e.commit("src.txt", "1\n2\n3\n4\nfive\n", "change line 5");
    let stashes = e.stashes();
    let index = e.index();

    e.apply("src.txt", false).unwrap();
    assert_eq!(e.text("src.txt").unwrap(), "1\nstashed\n3\n4\nfive\n");
    assert_eq!(e.status(), " M src.txt");
    assert_eq!(e.index(), index, "the index entry is left as it was");
    assert_eq!(e.text("README.md").unwrap(), "# Fixture\n");
    assert_eq!(e.stashes(), stashes);
    // The previous file is in a discard-like backup.
    let backups: Vec<_> = std::fs::read_dir(e.fx.root.join("backups"))
        .unwrap()
        .map(|d| d.unwrap().path())
        .collect();
    assert_eq!(backups.len(), 1);
    let manifest = std::fs::read_to_string(backups[0].join("manifest.json")).unwrap();
    assert!(manifest.contains("\"stashApplyFile\"") && manifest.contains("\"src.txt\""));
    assert_eq!(
        std::fs::read_to_string(backups[0].join("worktree-0")).unwrap(),
        "1\n2\n3\n4\nfive\n"
    );

    let entry = e.repos.undo(e.id).unwrap();
    assert!(matches!(
        entry.op,
        JournalOp::StashApplyFile { ref path, .. } if path == "src.txt"
    ));
    assert_eq!(e.text("src.txt").unwrap(), "1\n2\n3\n4\nfive\n");
    assert_eq!(e.status(), "");
    assert_eq!(e.stashes(), stashes);

    e.repos.redo(e.id).unwrap();
    assert_eq!(e.text("src.txt").unwrap(), "1\nstashed\n3\n4\nfive\n");
    assert_eq!(e.status(), " M src.txt");
}

#[test]
fn a_staged_version_stays_staged() {
    let e = env();
    e.stash_line_two();
    e.write("src.txt", "1\n2\n3\n4\nstaged\n");
    e.fx.git(&["add", "src.txt"]);
    let index = e.index();

    e.apply("src.txt", false).unwrap();
    assert_eq!(e.text("src.txt").unwrap(), "1\nstashed\n3\n4\nstaged\n");
    assert_eq!(e.status(), "MM src.txt");
    assert_eq!(e.index(), index);

    e.repos.undo(e.id).unwrap();
    assert_eq!(e.text("src.txt").unwrap(), "1\n2\n3\n4\nstaged\n");
    assert_eq!(e.status(), "M  src.txt");
    assert_eq!(e.index(), index);
}

#[test]
fn a_conflict_is_reported_like_stash_apply_and_can_be_undone() {
    let e = env();
    e.stash_line_two();
    e.commit("src.txt", "1\nmine\n3\n4\n5\n", "change line 2");
    let stashes = e.stashes();
    let index = e.index();

    let err = error(e.apply("src.txt", false));
    assert_eq!(err.code, ErrorCode::StashConflict);
    assert!(matches!(
        err.payload.as_deref(),
        Some(ErrorPayload::StashConflict { paths, stash_sha, checked_out: false })
            if paths == &["src.txt"] && *stash_sha == e.stash(0).sha
    ));
    assert_eq!(e.status(), "UU src.txt");
    assert_eq!(
        e.out(&["ls-files", "-u", "--", "src.txt"]).lines().count(),
        3
    );
    let merged = e.text("src.txt").unwrap();
    assert!(merged.contains("<<<<<<<") && merged.contains("mine") && merged.contains("stashed"));
    assert_eq!(e.stashes(), stashes);

    let conflicted = e.index();

    e.repos.undo(e.id).unwrap();
    assert_eq!(e.text("src.txt").unwrap(), "1\nmine\n3\n4\n5\n");
    assert_eq!(e.status(), "");
    assert_eq!(e.index(), index);
    assert_eq!(e.stashes(), stashes);

    // The redo brings the conflict back, stages included.
    e.repos.redo(e.id).unwrap();
    assert_eq!(e.text("src.txt").unwrap(), merged);
    assert_eq!(e.index(), conflicted);
    assert_eq!(e.status(), "UU src.txt");
}

#[test]
fn local_changes_to_the_file_are_refused() {
    let e = env();
    e.stash_line_two();
    e.write("src.txt", "1\n2\n3\n4\nlocal\n");

    let err = error(e.apply("src.txt", false));
    assert_eq!(err.code, ErrorCode::DirtyWorktree);
    assert!(matches!(
        err.payload.as_deref(),
        Some(ErrorPayload::DirtyWorktree { paths, can_carry: false }) if paths == &["src.txt"]
    ));
    assert_eq!(e.text("src.txt").unwrap(), "1\n2\n3\n4\nlocal\n");
    assert_eq!(e.status(), " M src.txt");
    assert!(e.repos.undo(e.id).is_err(), "nothing was journaled");
}

#[test]
fn an_untracked_file_is_written_without_touching_the_index() {
    let e = env();
    e.write("notes.txt", "notes\n");
    e.write("other.txt", "other\n");
    e.fx.git(&["stash", "-q", "--include-untracked"]);
    let stashes = e.stashes();
    let index = e.index();

    e.apply("notes.txt", true).unwrap();
    assert_eq!(e.text("notes.txt").unwrap(), "notes\n");
    assert_eq!(e.read("other.txt"), None);
    assert_eq!(e.status(), "?? notes.txt");
    assert_eq!(e.index(), index);
    assert_eq!(e.stashes(), stashes);

    e.repos.undo(e.id).unwrap();
    assert_eq!(e.read("notes.txt"), None);
    assert_eq!(e.status(), "");
    assert_eq!(e.stashes(), stashes);
}

#[test]
fn an_untracked_file_already_there_is_refused() {
    let e = env();
    e.write("notes.txt", "stashed\n");
    e.fx.git(&["stash", "-q", "--include-untracked"]);
    e.write("notes.txt", "mine\n");

    let err = error(e.apply("notes.txt", true));
    assert_eq!(err.code, ErrorCode::DirtyWorktree);
    assert_eq!(e.text("notes.txt").unwrap(), "mine\n");
}

#[test]
fn a_binary_file_applies_or_conflicts() {
    let e = env();
    e.commit("logo.bin", [0u8, 1, 2, 3], "add a binary");
    e.write("logo.bin", [0u8, 9, 9, 9]);
    e.fx.git(&["stash", "-q"]);

    e.apply("logo.bin", false).unwrap();
    assert_eq!(e.read("logo.bin").unwrap(), [0u8, 9, 9, 9]);
    assert_eq!(e.status(), " M logo.bin");
    e.repos.undo(e.id).unwrap();
    assert_eq!(e.read("logo.bin").unwrap(), [0u8, 1, 2, 3]);

    // Changed on both sides: Git cannot merge binaries, the working tree keeps ours.
    e.commit("logo.bin", [0u8, 7, 7, 7], "change the binary");
    let err = error(e.apply("logo.bin", false));
    assert_eq!(err.code, ErrorCode::StashConflict);
    assert_eq!(e.read("logo.bin").unwrap(), [0u8, 7, 7, 7]);
    assert_eq!(e.status(), "UU logo.bin");
    e.repos.undo(e.id).unwrap();
    assert_eq!(e.status(), "");
    assert_eq!(e.read("logo.bin").unwrap(), [0u8, 7, 7, 7]);
}

#[test]
fn a_file_deleted_in_the_stash_is_deleted_unstaged() {
    let e = env();
    std::fs::remove_file(e.fx.repo().join("src.txt")).unwrap();
    e.fx.git(&["stash", "-q"]);

    e.apply("src.txt", false).unwrap();
    assert_eq!(e.read("src.txt"), None);
    assert_eq!(e.status(), " D src.txt");

    e.repos.undo(e.id).unwrap();
    assert_eq!(e.text("src.txt").unwrap(), "line 1\n");
    assert_eq!(e.status(), "");
}

#[test]
fn a_file_added_in_the_stash_is_staged_like_stash_apply() {
    let e = env();
    e.write("added.txt", "added\n");
    e.fx.git(&["add", "added.txt"]);
    e.fx.git(&["stash", "-q"]);

    e.apply("added.txt", false).unwrap();
    assert_eq!(e.text("added.txt").unwrap(), "added\n");
    assert_eq!(e.status(), "A  added.txt");

    e.repos.undo(e.id).unwrap();
    assert_eq!(e.read("added.txt"), None);
    assert_eq!(e.status(), "");

    // An untracked file at the path the stash adds is not overwritten.
    e.write("added.txt", "mine\n");
    let err = error(e.apply("added.txt", false));
    assert_eq!(err.code, ErrorCode::DirtyWorktree);
    assert_eq!(e.text("added.txt").unwrap(), "mine\n");
}

#[test]
fn a_file_gone_on_our_side_is_refused() {
    let e = env();
    e.stash_line_two();
    e.fx.git(&["rm", "-q", "src.txt"]);
    e.fx.git(&["commit", "-q", "-m", "remove src"]);

    let err = error(e.apply("src.txt", false));
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    assert_eq!(e.read("src.txt"), None);
    assert_eq!(e.status(), "");
}

#[test]
fn paths_outside_the_stash_and_stale_entries_are_refused() {
    let e = env();
    e.stash_line_two();
    assert_eq!(
        error(e.apply("missing.txt", false)).code,
        ErrorCode::InvalidArgument
    );
    // No untracked part in this stash.
    assert_eq!(
        error(e.apply("src.txt", true)).code,
        ErrorCode::InvalidArgument
    );
    let stale = StashId {
        index: 0,
        sha: "0".repeat(40),
    };
    let err = e
        .repos
        .stash_apply_file(
            e.id,
            StashFileRequest {
                stash: stale,
                path: "src.txt".into(),
                untracked: false,
            },
        )
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::StaleRefs);
    assert_eq!(e.status(), "");
}

#[test]
fn a_conflict_ends_the_operation_failed_with_its_undo_journaled() {
    let e = env();
    e.stash_line_two();
    e.commit("src.txt", "1\nmine\n3\n4\n5\n", "change line 2");
    e.sink.clear();

    let err = error(e.apply("src.txt", false));
    assert_eq!(err.code, ErrorCode::StashConflict);
    let events = e.sink.events();
    let outcomes: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            BackendEvent::OpFinished(f) if f.kind == OpKind::Stash => Some(&f.outcome),
            _ => None,
        })
        .collect();
    assert!(
        matches!(
            outcomes[..],
            [OpOutcome::Failed { error }] if error.code == ErrorCode::StashConflict
        ),
        "{outcomes:?}"
    );
    // The journal is reported changed after the operation, and the undo is there.
    let finished = events
        .iter()
        .position(|event| matches!(event, BackendEvent::OpFinished(_)));
    let journal = events
        .iter()
        .position(|event| matches!(event, BackendEvent::JournalChanged(_)));
    assert!(finished.is_some() && journal > finished, "{events:?}");
    let entries = e.repos.op_history(e.id).unwrap();
    assert!(matches!(
        entries.first().map(|entry| &entry.op),
        Some(JournalOp::StashApplyFile { path, .. }) if path == "src.txt"
    ));
    e.repos.undo(e.id).unwrap();
    assert_eq!(e.status(), "");
}
