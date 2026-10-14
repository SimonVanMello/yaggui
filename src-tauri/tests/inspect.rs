//! File history, blame and reflog (M4-4) on the `inspect` fixture: renames, a merge, a
//! binary, reflog moves and uncommitted changes. Restoring a reflog entry reuses the reset
//! and branch creation of M3-1 / M2-2: checked here on the resulting Git state.

mod common;

use std::process::Command;
use std::sync::Arc;

use common::{Fixture, RecordingSink};
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::errors::ErrorCode;
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::ops::types::{BranchStart, ResetMode, ResetRequest};
use yaggui_lib::git::read::blame::{Blame, BlameContent, BlameRequest};
use yaggui_lib::git::read::diff::types::FileStatus;
use yaggui_lib::git::read::file_history::FileHistoryEntry;
use yaggui_lib::repo::RepoManager;
use yaggui_lib::store::Store;

struct Env {
    fx: Fixture,
    repos: Arc<RepoManager>,
    id: u32,
}

fn env() -> Env {
    let fx = Fixture::new("inspect");
    let sink = Arc::new(RecordingSink::default());
    let git = GitCli::new(Arc::new(CommandLog::new()), sink.clone())
        .with_env("GIT_CONFIG_NOSYSTEM", "1")
        .with_env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .with_env("GIT_COMMITTER_NAME", "yaggui Tests")
        .with_env("GIT_COMMITTER_EMAIL", "tests@yaggui.dev");
    let store = Arc::new(Store::open_in_memory().unwrap());
    let repos = Arc::new(
        RepoManager::new(Arc::new(git), store, sink)
            .without_watcher()
            .with_backup_dir(fx.root.join("backups")),
    );
    let id = repos.open(&fx.repo_str()).unwrap().id;
    Env { fx, repos, id }
}

impl Env {
    fn git_out(&self, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(self.fx.repo())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .output()
            .expect("run git");
        assert!(output.status.success(), "git {args:?} failed");
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    fn sha(&self, rev: &str) -> String {
        self.git_out(&["rev-parse", rev])
    }

    fn history(&self, path: &str, limit: u32) -> Vec<FileHistoryEntry> {
        let mut entries = Vec::new();
        let mut cursor = None;
        loop {
            let page = self
                .repos
                .file_history(self.id, path, None, cursor, limit, 1)
                .unwrap();
            assert!(page.entries.len() <= limit as usize);
            entries.extend(page.entries);
            match page.next {
                Some(next) => cursor = Some(next),
                None => return entries,
            }
        }
    }

    fn blame(&self, path: &str, rev: Option<&str>) -> Blame {
        self.repos
            .blame(
                self.id,
                &BlameRequest {
                    path: path.to_owned(),
                    rev: rev.map(str::to_owned),
                },
                2,
            )
            .unwrap()
    }
}

/// Summary of the commit each line is attributed to.
fn attribution(blame: &Blame) -> Vec<(String, String)> {
    let BlameContent::Text {
        lines,
        commits,
        chunks,
        ..
    } = &blame.content
    else {
        panic!("expected text, got {:?}", blame.content);
    };
    let mut out = vec![(String::new(), String::new()); lines.len()];
    let mut covered = 0;
    for chunk in chunks {
        let commit = &commits[chunk.commit as usize];
        let label = if commit.uncommitted {
            "uncommitted".to_owned()
        } else {
            commit.summary.clone()
        };
        for line in chunk.start..chunk.start + chunk.count {
            out[line as usize] = (lines[line as usize].clone(), label.clone());
            covered += 1;
        }
    }
    assert_eq!(covered, lines.len(), "every line attributed once");
    out
}

#[test]
fn file_history_follows_renames_like_git_follow() {
    let env = env();
    let entries = env.history("core/library.txt", 500);
    let summaries: Vec<_> = entries.iter().map(|e| e.summary.as_str()).collect();
    assert_eq!(
        summaries,
        [
            "rename to library",
            "merge side",
            "main: edit lib",
            "side: edit lib",
            "move lib to core",
            "edit lib",
            "add lib",
        ]
    );
    // Same commits as `git log --follow`, which leaves out the merge.
    let follow = env.git_out(&["log", "--follow", "--format=%H", "--", "core/library.txt"]);
    let ours: Vec<_> = entries
        .iter()
        .filter(|e| e.parents.len() < 2)
        .map(|e| e.sha.as_str())
        .collect();
    assert_eq!(ours, follow.lines().collect::<Vec<_>>());

    let rename = &entries[0];
    assert_eq!(rename.status, FileStatus::Renamed);
    assert_eq!(rename.path, "core/library.txt");
    assert_eq!(rename.old_path.as_deref(), Some("core/lib.txt"));
    assert_eq!(rename.similarity, Some(100));
    let merge = &entries[1];
    assert_eq!(merge.parents.len(), 2);
    assert_eq!(merge.path, "core/lib.txt");
    let moved = &entries[4];
    assert_eq!(moved.status, FileStatus::Renamed);
    assert_eq!(moved.old_path.as_deref(), Some("src/lib.txt"));
    assert!(moved.similarity.is_some_and(|s| s < 100));
    assert_eq!(entries[5].path, "src/lib.txt");
    assert_eq!(entries[6].status, FileStatus::Added);
    assert_eq!(entries[6].author_name, "yaggui Tests");
}

#[test]
fn file_history_pages_join_across_renames() {
    let env = env();
    let all = env.history("core/library.txt", 500);
    for limit in [1, 2, 3] {
        let paged = env.history("core/library.txt", limit);
        assert_eq!(paged, all, "pages of {limit}");
    }
}

#[test]
fn file_history_from_a_revision_and_of_unknown_paths() {
    let env = env();
    let entries = env
        .repos
        .file_history(env.id, "src/lib.txt", Some("HEAD~6"), None, 500, 3)
        .unwrap();
    let summaries: Vec<_> = entries.entries.iter().map(|e| e.summary.as_str()).collect();
    assert_eq!(summaries, ["edit lib", "add lib"]);

    let none = env
        .repos
        .file_history(env.id, "nope.txt", None, None, 500, 3)
        .unwrap();
    assert!(none.entries.is_empty() && none.next.is_none());

    let err = env
        .repos
        .file_history(env.id, "../outside", None, None, 500, 3)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    let err = env
        .repos
        .file_history(env.id, "a.txt", Some("no-such-rev"), None, 500, 3)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::RevisionNotFound);
}

#[test]
fn blame_at_head_follows_renames_and_merges() {
    let env = env();
    let blame = env.blame("core/library.txt", Some("HEAD"));
    assert_eq!(blame.rev.as_deref(), Some(env.sha("HEAD").as_str()));
    let lines: Vec<_> = attribution(&blame)
        .into_iter()
        .map(|(line, summary)| format!("{line}: {summary}"))
        .collect();
    assert_eq!(
        lines,
        [
            "ONE: main: edit lib",
            "TWO: edit lib",
            "three: add lib",
            "four: add lib",
            "FIVE: side: edit lib",
            "six: move lib to core",
        ]
    );
    let BlameContent::Text { commits, .. } = &blame.content else {
        unreachable!()
    };
    let root = commits.iter().find(|c| c.summary == "add lib").unwrap();
    assert_eq!(root.path, "src/lib.txt");
    assert_eq!(root.previous, None);
    let edit = commits.iter().find(|c| c.summary == "edit lib").unwrap();
    assert_eq!(edit.author_email, "tests@yaggui.dev");
    let previous = edit.previous.as_ref().unwrap();
    assert_eq!(previous.path, "src/lib.txt");

    // "Blame of the parent": the version before "edit lib".
    let parent = env.blame(&previous.path, Some(&previous.sha));
    let lines: Vec<_> = attribution(&parent).into_iter().map(|(l, _)| l).collect();
    assert_eq!(lines, ["one", "two", "three", "four", "five"]);
}

#[test]
fn blame_of_the_working_tree_marks_uncommitted_lines() {
    let env = env();
    let blame = env.blame("core/library.txt", None);
    assert_eq!(blame.rev, None);
    let lines = attribution(&blame);
    assert_eq!(lines[2], ("local".to_owned(), "uncommitted".to_owned()));
    assert_eq!(lines[0].1, "main: edit lib");
}

#[test]
fn blame_handles_binaries_new_and_deleted_files() {
    let env = env();
    assert!(matches!(
        env.blame("assets/logo.png", Some("HEAD")).content,
        BlameContent::Binary { size } if size > 0.0
    ));
    assert_eq!(
        env.blame("untracked.txt", None).content,
        BlameContent::NotCommitted
    );
    assert_eq!(
        env.blame("staged.txt", None).content,
        BlameContent::NotCommitted
    );
    // Deleted from the working tree: the HEAD version.
    std::fs::remove_file(env.fx.repo().join("other.txt")).unwrap();
    let deleted = env.blame("other.txt", None);
    assert_eq!(deleted.rev.as_deref(), Some(env.sha("HEAD").as_str()));
    assert_eq!(attribution(&deleted)[0].1, "touch other");

    let err = env
        .repos
        .blame(
            env.id,
            &BlameRequest {
                path: "core/lib.txt".into(),
                rev: Some("HEAD".into()),
            },
            2,
        )
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
}

#[test]
fn reads_are_cancellable_by_token() {
    let env = env();
    // Cancelled before it starts (the cancel request won the race).
    env.repos.cancel_read(42);
    let err = env
        .repos
        .blame(
            env.id,
            &BlameRequest {
                path: "core/library.txt".into(),
                rev: Some("HEAD".into()),
            },
            42,
        )
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);
    env.repos.cancel_read(43);
    let err = env
        .repos
        .file_history(env.id, "core/library.txt", None, None, 500, 43)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);
    // The token is released: a new read with it runs.
    assert!(
        env.repos
            .file_history(env.id, "core/library.txt", None, None, 500, 43)
            .is_ok()
    );
}

#[test]
fn reflog_of_head_and_of_a_branch() {
    let env = env();
    let head = env.repos.reflog(env.id, "HEAD", 0, 500).unwrap();
    let messages: Vec<_> = head.entries.iter().map(|e| e.message.as_str()).collect();
    assert_eq!(
        &messages[..5],
        [
            "reset: moving to HEAD~1",
            "commit: oops",
            "checkout: moving from side to main",
            "checkout: moving from main to side",
            "commit: add logo",
        ]
    );
    assert_eq!(head.total as usize, head.entries.len());
    assert_eq!(head.entries[0].index, 0);
    assert_eq!(head.entries[0].new_sha, env.sha("HEAD"));
    assert_eq!(head.entries[1].new_sha, env.sha("HEAD@{1}"));
    assert!(head.entries.iter().all(|e| e.exists));
    assert_eq!(head.entries[0].committer_name, "yaggui Tests");
    let first = head.entries.last().unwrap();
    assert_eq!(first.old_sha, None);

    let page = env.repos.reflog(env.id, "HEAD", 1, 2).unwrap();
    assert_eq!(page.entries.len(), 2);
    assert_eq!(page.entries[0].index, 1);
    assert_eq!(page.entries[0].message, "commit: oops");

    let side = env.repos.reflog(env.id, "refs/heads/side", 0, 500).unwrap();
    assert_eq!(side.entries[0].message, "commit: side: edit lib");
    assert_eq!(side.entries[0].new_sha, env.sha("side"));

    for bad in ["main", "refs/tags/v1", "refs/heads/../x", "--all"] {
        let err = env.repos.reflog(env.id, bad, 0, 10).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidArgument, "{bad}");
    }
    let err = env
        .repos
        .reflog(env.id, "refs/heads/nope", 0, 10)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::RevisionNotFound);
}

#[test]
fn restoring_a_reflog_entry_by_reset_or_new_branch() {
    let env = env();
    let head = env.repos.reflog(env.id, "HEAD", 0, 500).unwrap();
    let lost = head.entries[1].new_sha.clone(); // "commit: oops", undone by the reset.

    env.repos
        .create_branch(
            env.id,
            "rescued",
            BranchStart::Commit { sha: lost.clone() },
            false,
        )
        .unwrap();
    assert_eq!(env.sha("rescued"), lost);

    env.repos
        .reset(
            env.id,
            ResetRequest {
                target: lost.clone(),
                mode: ResetMode::Soft,
            },
        )
        .unwrap();
    assert_eq!(env.sha("HEAD"), lost);
    assert_eq!(env.sha("main"), lost);
    let after = env.repos.reflog(env.id, "HEAD", 0, 1).unwrap();
    assert!(after.entries[0].message.starts_with("reset: moving to"));
    // A soft reset keeps the working tree.
    assert!(
        std::fs::read_to_string(env.fx.repo().join("core/library.txt"))
            .unwrap()
            .contains("local")
    );
}

/// Blame and file history through yaggui on a real repository (PR measurements):
/// `YAGGUI_BENCH_REPO=<worktree> YAGGUI_BENCH_FILES=a.c,b.c cargo test --release --test inspect
/// inspect_bench -- --ignored --nocapture`. Compares with `git log --follow`.
#[test]
#[ignore = "benchmark: needs YAGGUI_BENCH_REPO"]
fn inspect_bench() {
    let Ok(repo) = std::env::var("YAGGUI_BENCH_REPO") else {
        eprintln!("YAGGUI_BENCH_REPO not set");
        return;
    };
    let files = std::env::var("YAGGUI_BENCH_FILES").unwrap_or_else(|_| "README.md".into());
    let sink = Arc::new(RecordingSink::default());
    let git = Arc::new(GitCli::new(Arc::new(CommandLog::new()), sink.clone()));
    let store = Arc::new(Store::open_in_memory().unwrap());
    let repos = RepoManager::new(git, store, sink).without_watcher();
    let id = repos.open(&repo).unwrap().id;
    for file in files.split(',') {
        let start = std::time::Instant::now();
        let blame = repos
            .blame(
                id,
                &BlameRequest {
                    path: file.to_owned(),
                    rev: None,
                },
                1,
            )
            .unwrap();
        let blamed = start.elapsed();
        let lines = match &blame.content {
            BlameContent::Text { lines, chunks, .. } => (lines.len(), chunks.len()),
            _ => (0, 0),
        };
        let payload = serde_json::to_vec(&blame).unwrap().len();

        let start = std::time::Instant::now();
        let first = repos.file_history(id, file, None, None, 500, 2).unwrap();
        let first_page = start.elapsed();
        let mut total = first.entries.len();
        let mut next = first.next;
        while let Some(cursor) = next {
            let page = repos
                .file_history(id, file, None, Some(cursor), 500, 2)
                .unwrap();
            total += page.entries.len();
            next = page.next;
        }
        let history = start.elapsed();

        let start = std::time::Instant::now();
        let follow = Command::new("git")
            .args([
                "log",
                "--follow",
                "--format=%H",
                "--name-status",
                "-z",
                "--",
                file,
            ])
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(follow.status.success());
        let follow_time = start.elapsed();
        println!(
            "{file}: blame {blamed:?} ({} lines, {} chunks, {} KB JSON) | history first page \
             {first_page:?}, all {total} entries {history:?} | git log --follow {follow_time:?}",
            lines.0,
            lines.1,
            payload / 1024
        );
    }
}
