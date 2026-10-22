//! History of a line range (M7-7) on the `line-history` fixture: a range edited over several
//! commits and shifted by lines added above it, a rename with an edit inside the range, lines
//! moved within the file, a merge with the range edited on both sides, an uncommitted edit.

mod common;

use std::process::Command;
use std::sync::Arc;

use common::{Fixture, RecordingSink};
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::errors::ErrorCode;
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::read::diff::types::FileStatus;
use yaggui_lib::git::read::line_history::{LineHistoryEntry, LineHistoryRequest};
use yaggui_lib::repo::RepoManager;
use yaggui_lib::store::Store;

struct Env {
    fx: Fixture,
    repos: Arc<RepoManager>,
    id: u32,
}

fn env() -> Env {
    let fx = Fixture::new("line-history");
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
    Env { fx, repos, id }
}

fn request(path: &str, rev: Option<&str>, start: u32, end: u32) -> LineHistoryRequest {
    LineHistoryRequest {
        path: path.into(),
        rev: rev.map(str::to_owned),
        start,
        end,
    }
}

impl Env {
    fn sha(&self, rev: &str) -> String {
        let output = Command::new("git")
            .args(["rev-parse", rev])
            .current_dir(self.fx.repo())
            .output()
            .expect("run git");
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    /// Every entry, page by page.
    fn history(&self, request: &LineHistoryRequest, limit: u32) -> Vec<LineHistoryEntry> {
        let mut entries = Vec::new();
        let mut cursor = None;
        loop {
            let page = self
                .repos
                .line_history(self.id, request, cursor, limit, 1)
                .unwrap();
            assert!(page.entries.len() <= limit as usize);
            entries.extend(page.entries);
            match page.next {
                Some(next) => cursor = Some(next),
                None => return entries,
            }
        }
    }

    fn error(&self, request: &LineHistoryRequest) -> ErrorCode {
        self.repos
            .line_history(self.id, request, None, 500, 1)
            .unwrap_err()
            .code
    }
}

fn summaries(entries: &[LineHistoryEntry]) -> Vec<&str> {
    entries.iter().map(|e| e.summary.as_str()).collect()
}

#[test]
fn follows_a_range_edited_over_several_commits_across_a_rename() {
    let env = env();
    // `a5 v3` and `a6 v2`, shifted by the header and the moved tail since `add app`.
    let page = env
        .repos
        .line_history(
            env.id,
            &request("lib/app.txt", Some("HEAD"), 10, 11),
            None,
            500,
            1,
        )
        .unwrap();
    assert_eq!(page.range.rev, env.sha("HEAD"));
    assert_eq!((page.range.start, page.range.end), (10, 11));
    assert!(page.next.is_none());
    let entries = page.entries;
    // Neither the commits that only moved the range (header, tail) nor the other file.
    assert_eq!(
        summaries(&entries),
        vec!["move app to lib", "edit a6", "edit a5", "add app"]
    );

    let moved = &entries[0];
    assert_eq!(moved.status, FileStatus::Renamed);
    assert_eq!(moved.path, "lib/app.txt");
    assert_eq!(moved.old_path.as_deref(), Some("src/app.txt"));
    let hunk = &moved.diff.as_ref().unwrap().hunks[0];
    assert_eq!(hunk.kinds, "-+ ");
    assert_eq!(hunk.lines, vec!["a5 v2", "a5 v3", "a6 v2"]);
    assert_eq!((hunk.old_start, hunk.new_start), (8, 8));

    // Before the header was added, the range was at lines 5–6 of `src/app.txt`.
    let edit = &entries[2];
    assert_eq!(edit.path, "src/app.txt");
    assert_eq!(edit.status, FileStatus::Modified);
    let hunk = &edit.diff.as_ref().unwrap().hunks[0];
    assert_eq!((hunk.old_start, hunk.old_lines, hunk.new_start), (5, 2, 5));
    assert!(!edit.origin);

    let add = &entries[3];
    assert_eq!(add.status, FileStatus::Added);
    assert!(add.origin);
    assert_eq!(add.diff.as_ref().unwrap().hunks[0].kinds, "++");
}

#[test]
fn lines_moved_within_the_file_start_where_they_were_pasted() {
    let env = env();
    let entries = env.history(&request("lib/app.txt", None, 3, 4), 500);
    // Working tree lines 3–4 are HEAD lines 1–2 (`a9`, `a10`), moved to the top: Git does not
    // look for where they came from.
    assert_eq!(summaries(&entries), vec!["move tail to top"]);
    assert!(entries[0].origin);
    assert_eq!(entries[0].status, FileStatus::Modified);
}

#[test]
fn a_merge_that_combines_both_sides_is_listed_without_a_diff() {
    let env = env();
    let entries = env.history(&request("lib/app.txt", Some("HEAD"), 9, 12), 500);
    assert_eq!(
        summaries(&entries)[..3],
        ["merge side", "side: edit a7", "main: edit a4"]
    );
    assert_eq!(entries[0].parents.len(), 2);
    assert_eq!(entries[0].diff, None);
    assert_eq!(entries[0].path, "lib/app.txt");
    assert!(entries[1].diff.is_some());
}

#[test]
fn pages_join_into_the_whole_history() {
    let env = env();
    let request = request("lib/app.txt", Some("HEAD"), 10, 11);
    let whole = env.history(&request, 500);
    let paged = env.history(&request, 1);
    assert_eq!(whole, paged);
    assert_eq!(paged.len(), 4);
}

#[test]
fn working_tree_lines_are_mapped_to_head() {
    let env = env();
    // Two lines were inserted on top and `a6 v2` edited: working tree lines 12–13 are HEAD
    // lines 10–11.
    let page = env
        .repos
        .line_history(env.id, &request("lib/app.txt", None, 12, 13), None, 500, 1)
        .unwrap();
    assert_eq!(page.range.rev, env.sha("HEAD"));
    assert_eq!((page.range.start, page.range.end), (10, 11));
    assert_eq!(page.entries.len(), 4);
    // Only lines added in the working tree: nothing to follow.
    assert_eq!(
        env.error(&request("lib/app.txt", None, 1, 2)),
        ErrorCode::InvalidArgument
    );
}

#[test]
fn from_an_older_commit_under_its_old_name() {
    let env = env();
    let rev = env.sha(":/edit a6");
    let entries = env.history(&request("src/app.txt", Some(&rev), 8, 9), 500);
    assert_eq!(summaries(&entries), vec!["edit a6", "edit a5", "add app"]);
}

#[test]
fn paths_with_spaces_and_accents() {
    let env = env();
    let dir = env.fx.repo().join("docs");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("café notes.txt"), "one\ntwo\n").unwrap();
    env.fx.git(&["add", "-A"]);
    env.fx.git(&["commit", "-q", "-m", "add notes"]);
    std::fs::write(dir.join("café notes.txt"), "one\nTWO\n").unwrap();
    env.fx.git(&["commit", "-q", "-am", "edit notes"]);
    let entries = env.history(&request("docs/café notes.txt", Some("HEAD"), 2, 2), 500);
    assert_eq!(summaries(&entries), vec!["edit notes", "add notes"]);
    assert_eq!(entries[0].path, "docs/café notes.txt");
    assert_eq!(entries[0].status, FileStatus::Modified);
}

#[test]
fn invalid_ranges_and_files_are_typed_errors() {
    let env = env();
    let head = Some("HEAD");
    // HEAD's file has 13 lines.
    assert_eq!(
        env.error(&request("lib/app.txt", head, 13, 14)),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        env.error(&request("lib/app.txt", head, 0, 2)),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        env.error(&request("lib/app.txt", head, 5, 4)),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        env.error(&request("lib/app.txt", head, 1, 6_000)),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        env.error(&request("src/app.txt", head, 1, 1)),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        env.error(&request("../app.txt", head, 1, 1)),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        env.error(&request("lib/app.txt", Some("no-such-rev"), 1, 1)),
        ErrorCode::RevisionNotFound
    );
    std::fs::write(env.fx.repo().join("new.txt"), "new\n").unwrap();
    assert_eq!(
        env.error(&request("new.txt", None, 1, 1)),
        ErrorCode::InvalidArgument
    );
}

#[test]
fn cancellable_by_token() {
    let env = env();
    let request = request("lib/app.txt", Some("HEAD"), 10, 11);
    env.repos.cancel_read(7);
    let err = env
        .repos
        .line_history(env.id, &request, None, 500, 7)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);
    // The token is released: a new read with it runs.
    assert!(
        env.repos
            .line_history(env.id, &request, None, 500, 7)
            .is_ok()
    );
}
