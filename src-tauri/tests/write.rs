//! Staging, discard and commit (M2-1) on temporary repositories: each test checks the
//! resulting Git state.

mod common;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use common::{Fixture, RecordingSink};
use yaggui_lib::events::{BackendEvent, OpKind};
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::errors::{ErrorCode, ErrorPayload};
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::ops::types::{
    CommitRequest, ConfigScope, HunkChange, HunkSelection, PathSelection,
};
use yaggui_lib::git::read::diff::file_diff;
use yaggui_lib::git::read::diff::types::{
    DiffContent, DiffOptions, DiffTarget, FileDiff, TextDiff,
};
use yaggui_lib::repo::RepoManager;
use yaggui_lib::store::Store;

struct Env {
    fx: Fixture,
    sink: Arc<RecordingSink>,
    repos: Arc<RepoManager>,
    id: u32,
}

/// A `clean` fixture opened by a backend whose Git ignores the machine's configuration.
fn env() -> Env {
    env_with("clean")
}

fn env_with(scenario: &str) -> Env {
    let fx = Fixture::new(scenario);
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
    fn write(&self, path: &str, content: &[u8]) {
        let full = self.fx.repo().join(path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(full, content).unwrap();
    }

    fn read(&self, path: &str) -> Option<Vec<u8>> {
        std::fs::read(self.fx.repo().join(path)).ok()
    }

    fn git_out(&self, args: &[&str]) -> (bool, Vec<u8>) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(self.fx.repo())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        (out.status.success(), out.stdout)
    }

    /// Staged content of `path`, `None` when not in the index.
    fn index(&self, path: &str) -> Option<Vec<u8>> {
        let (ok, out) = self.git_out(&["show", &format!(":{path}")]);
        ok.then_some(out)
    }

    fn head(&self, path: &str) -> Option<Vec<u8>> {
        let (ok, out) = self.git_out(&["show", &format!("HEAD:{path}")]);
        ok.then_some(out)
    }

    /// Commit `files` with the fixture's git (setup only).
    fn commit_files(&self, files: &[(&str, &[u8])]) {
        for (path, content) in files {
            self.write(path, content);
            self.fx.git(&["add", "--", path]);
        }
        self.fx.git(&["commit", "-q", "-m", "setup"]);
    }

    fn diff(&self, target: DiffTarget, path: &str, old_path: Option<&str>) -> (FileDiff, TextDiff) {
        let repo = gix::open(self.fx.repo()).unwrap();
        let diff = file_diff(&repo, &target, path, old_path, &DiffOptions::default()).unwrap();
        let text = match &diff.content {
            DiffContent::Text(text) => text.clone(),
            other => panic!("expected text, got {other:?}"),
        };
        (diff, text)
    }

    /// A selection on the current diff of `path`: `pick(hunk index, kinds)` returns the line
    /// indexes to take in that hunk (`None`: the whole hunk, skipped when empty).
    fn change(
        &self,
        target: DiffTarget,
        path: &str,
        old_path: Option<&str>,
        pick: impl Fn(usize, &str) -> Option<Vec<u32>>,
    ) -> HunkChange {
        let (diff, text) = self.diff(target, path, old_path);
        HunkChange {
            path: path.to_owned(),
            old_path: old_path.map(str::to_owned),
            old_id: diff.old_id,
            new_id: diff.new_id,
            options: DiffOptions::default(),
            hunks: text
                .hunks
                .iter()
                .enumerate()
                .map(|(i, h)| HunkSelection {
                    id: h.id.clone(),
                    lines: pick(i, &h.kinds),
                })
                .collect(),
        }
    }
}

fn paths(list: &[&str]) -> PathSelection {
    PathSelection::Paths {
        paths: list.iter().map(|p| (*p).to_owned()).collect(),
    }
}

/// Indexes of the lines of `kinds` whose text (in `lines`) is in `wanted`.
fn lines_of(text: &TextDiff, hunk: usize, wanted: &[(char, &str)]) -> Vec<u32> {
    let h = &text.hunks[hunk];
    h.kinds
        .chars()
        .zip(&h.lines)
        .enumerate()
        .filter(|(_, (k, l))| wanted.iter().any(|(wk, wl)| wk == k && wl == l))
        .map(|(i, _)| u32::try_from(i).unwrap())
        .collect()
}

fn numbered(n: u32) -> String {
    (1..=n).map(|i| format!("line {i}\n")).collect()
}

fn commit_request(summary: &str) -> CommitRequest {
    CommitRequest {
        summary: summary.to_owned(),
        description: String::new(),
        amend: false,
        skip_hooks: false,
    }
}

// ---- Files ------------------------------------------------------------------------------

#[test]
fn stages_and_unstages_whole_files() {
    let e = env();
    e.write("README.md", b"changed\n");
    e.write("new file*.txt", b"new\n");
    e.write("other.txt", b"other\n");
    e.repos
        .stage_paths(e.id, paths(&["README.md", "new file*.txt"]))
        .unwrap();
    assert_eq!(e.index("README.md").unwrap(), b"changed\n");
    assert_eq!(e.index("new file*.txt").unwrap(), b"new\n");
    // A literal pathspec: `*` matched nothing else.
    assert_eq!(e.index("other.txt"), None);

    e.repos.unstage_paths(e.id, paths(&["README.md"])).unwrap();
    assert_eq!(e.index("README.md"), e.head("README.md"));
    e.repos.stage_paths(e.id, PathSelection::All).unwrap();
    assert_eq!(e.index("other.txt").unwrap(), b"other\n");
    e.repos.unstage_paths(e.id, PathSelection::All).unwrap();
    assert_eq!(e.index("other.txt"), None);
    assert_eq!(e.index("README.md"), e.head("README.md"));
}

#[test]
fn stages_a_deletion_and_refuses_paths_outside_the_repo() {
    let e = env();
    std::fs::remove_file(e.fx.repo().join("README.md")).unwrap();
    e.repos.stage_paths(e.id, paths(&["README.md"])).unwrap();
    assert_eq!(e.index("README.md"), None);
    for bad in ["../x", "/etc/passwd", ""] {
        let err = e.repos.stage_paths(e.id, paths(&[bad])).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidArgument, "{bad}");
    }
}

#[test]
fn unstaging_a_rename_restores_its_source() {
    let e = env();
    e.commit_files(&[("old.txt", numbered(20).as_bytes())]);
    e.fx.git(&["mv", "old.txt", "new.txt"]);
    e.repos.unstage_paths(e.id, paths(&["new.txt"])).unwrap();
    assert_eq!(e.index("new.txt"), None);
    assert_eq!(e.index("old.txt").unwrap(), numbered(20).as_bytes());
}

// ---- Hunks and lines --------------------------------------------------------------------

#[test]
fn stages_and_unstages_one_line_in_the_middle_of_a_hunk() {
    let e = env();
    let old = numbered(10);
    e.commit_files(&[("f.txt", old.as_bytes())]);
    let new = old
        .replace("line 4\n", "LINE 4\n")
        .replace("line 5\n", "LINE 5\n")
        .replace("line 6\n", "LINE 6\n");
    e.write("f.txt", new.as_bytes());

    let (_, text) = e.diff(DiffTarget::Unstaged, "f.txt", None);
    assert_eq!(text.hunks.len(), 1);
    let pick = lines_of(&text, 0, &[('-', "line 5"), ('+', "LINE 5")]);
    assert_eq!(pick.len(), 2);
    let change = e.change(DiffTarget::Unstaged, "f.txt", None, |_, _| {
        Some(pick.clone())
    });
    e.repos.stage_hunks(e.id, change).unwrap();
    assert_eq!(
        e.index("f.txt").unwrap(),
        old.replace("line 5\n", "LINE 5\n").as_bytes()
    );
    // The working tree is untouched.
    assert_eq!(e.read("f.txt").unwrap(), new.as_bytes());

    // Unstage that line again, from the staged diff.
    let (_, staged) = e.diff(DiffTarget::Staged, "f.txt", None);
    let pick = lines_of(&staged, 0, &[('-', "line 5"), ('+', "LINE 5")]);
    let change = e.change(DiffTarget::Staged, "f.txt", None, |_, _| Some(pick.clone()));
    e.repos.unstage_hunks(e.id, change).unwrap();
    assert_eq!(e.index("f.txt").unwrap(), old.as_bytes());
}

#[test]
fn stages_one_hunk_of_several() {
    let e = env();
    let old = numbered(40);
    e.commit_files(&[("f.txt", old.as_bytes())]);
    let new = old
        .replace("line 2\n", "line 2 bis\n")
        .replace("line 30\n", "")
        .replace("line 38\n", "line 38\nadded\n");
    e.write("f.txt", new.as_bytes());
    let (_, text) = e.diff(DiffTarget::Unstaged, "f.txt", None);
    assert_eq!(text.hunks.len(), 3);
    // The last two hunks (deletion of 30, addition after 38).
    let change = e.change(DiffTarget::Unstaged, "f.txt", None, |i, _| {
        if i >= 1 { None } else { Some(Vec::new()) }
    });
    e.repos.stage_hunks(e.id, change).unwrap();
    assert_eq!(
        e.index("f.txt").unwrap(),
        old.replace("line 30\n", "")
            .replace("line 38\n", "line 38\nadded\n")
            .as_bytes()
    );
}

#[test]
fn handles_a_last_line_without_newline() {
    let e = env();
    e.commit_files(&[("f.txt", b"a\nb")]);
    e.write("f.txt", b"a\nb\nc\n");
    let (_, text) = e.diff(DiffTarget::Unstaged, "f.txt", None);
    assert_eq!(text.hunks[0].kinds, " -++");

    // Only "+c": b has to gain its newline for c to follow it.
    let change = e.change(DiffTarget::Unstaged, "f.txt", None, |_, _| Some(vec![3]));
    e.repos.stage_hunks(e.id, change).unwrap();
    assert_eq!(e.index("f.txt").unwrap(), b"a\nb\nc\n");
    e.repos.unstage_paths(e.id, paths(&["f.txt"])).unwrap();

    // Only the newline fix ("-b" / "+b").
    let change = e.change(DiffTarget::Unstaged, "f.txt", None, |_, _| Some(vec![1, 2]));
    e.repos.stage_hunks(e.id, change).unwrap();
    assert_eq!(e.index("f.txt").unwrap(), b"a\nb\n");

    // Reverse: stage everything, then unstage "+c" only.
    e.repos.stage_paths(e.id, paths(&["f.txt"])).unwrap();
    let change = e.change(DiffTarget::Staged, "f.txt", None, |_, _| Some(vec![3]));
    e.repos.unstage_hunks(e.id, change).unwrap();
    assert_eq!(e.index("f.txt").unwrap(), b"a\nb\n");

    // A new last line without newline.
    e.repos.unstage_paths(e.id, PathSelection::All).unwrap();
    e.write("f.txt", b"a\nb\nc");
    let (_, text) = e.diff(DiffTarget::Unstaged, "f.txt", None);
    assert_eq!(text.hunks[0].kinds, " -++");
    let change = e.change(DiffTarget::Unstaged, "f.txt", None, |_, _| Some(vec![3]));
    e.repos.stage_hunks(e.id, change).unwrap();
    assert_eq!(e.index("f.txt").unwrap(), b"a\nb\nc");
}

#[test]
fn stages_lines_of_a_crlf_file() {
    let e = env();
    e.commit_files(&[("w.txt", b"l1\r\nl2\r\nl3\r\nl4\r\n")]);
    e.write("w.txt", b"l1\r\nL2\r\nl3\r\nL4\r\n");
    let (_, text) = e.diff(DiffTarget::Unstaged, "w.txt", None);
    let pick = lines_of(&text, 0, &[('-', "l2"), ('+', "L2")]);
    assert_eq!(pick.len(), 2);
    let change = e.change(DiffTarget::Unstaged, "w.txt", None, |_, _| {
        Some(pick.clone())
    });
    e.repos.stage_hunks(e.id, change).unwrap();
    assert_eq!(e.index("w.txt").unwrap(), b"l1\r\nL2\r\nl3\r\nl4\r\n");

    // Discard the other line: the working tree keeps its CRLF endings.
    let (_, text) = e.diff(DiffTarget::Unstaged, "w.txt", None);
    let pick = lines_of(&text, 0, &[('-', "l4"), ('+', "L4")]);
    let change = e.change(DiffTarget::Unstaged, "w.txt", None, |_, _| {
        Some(pick.clone())
    });
    e.repos.discard_hunks(e.id, change).unwrap();
    assert_eq!(e.read("w.txt").unwrap(), b"l1\r\nL2\r\nl3\r\nl4\r\n");
}

#[test]
fn stages_lines_with_autocrlf() {
    let e = env();
    e.fx.git(&["config", "core.autocrlf", "true"]);
    e.commit_files(&[("w.txt", b"l1\nl2\nl3\nl4\n")]);
    e.write("w.txt", b"l1\r\nL2\r\nl3\r\nL4\r\n");
    let (_, text) = e.diff(DiffTarget::Unstaged, "w.txt", None);
    let pick = lines_of(&text, 0, &[('-', "l2"), ('+', "L2")]);
    let change = e.change(DiffTarget::Unstaged, "w.txt", None, |_, _| {
        Some(pick.clone())
    });
    e.repos.stage_hunks(e.id, change).unwrap();
    assert_eq!(e.index("w.txt").unwrap(), b"l1\nL2\nl3\nl4\n");

    let (_, text) = e.diff(DiffTarget::Unstaged, "w.txt", None);
    let pick = lines_of(&text, 0, &[('-', "l4"), ('+', "L4")]);
    let change = e.change(DiffTarget::Unstaged, "w.txt", None, |_, _| {
        Some(pick.clone())
    });
    e.repos.discard_hunks(e.id, change).unwrap();
    assert_eq!(e.read("w.txt").unwrap(), b"l1\r\nL2\r\nl3\r\nl4\r\n");
}

#[test]
fn stages_part_of_an_untracked_file() {
    let e = env();
    e.write("n.txt", b"one\ntwo\nthree\n");
    let change = e.change(DiffTarget::Unstaged, "n.txt", None, |_, _| Some(vec![0, 2]));
    e.repos.stage_hunks(e.id, change).unwrap();
    assert_eq!(e.index("n.txt").unwrap(), b"one\nthree\n");
}

#[test]
fn unstages_lines_of_a_staged_rename() {
    let e = env();
    let old = numbered(20);
    e.commit_files(&[("old.txt", old.as_bytes())]);
    e.fx.git(&["mv", "old.txt", "new.txt"]);
    let new = old
        .replace("line 3\n", "LINE 3\n")
        .replace("line 15\n", "LINE 15\n");
    e.write("new.txt", new.as_bytes());
    e.fx.git(&["add", "new.txt"]);
    let (_, text) = e.diff(DiffTarget::Staged, "new.txt", Some("old.txt"));
    assert_eq!(text.hunks.len(), 2);
    let change = e.change(DiffTarget::Staged, "new.txt", Some("old.txt"), |i, _| {
        if i == 0 { None } else { Some(Vec::new()) }
    });
    e.repos.unstage_hunks(e.id, change).unwrap();
    assert_eq!(
        e.index("new.txt").unwrap(),
        old.replace("line 15\n", "LINE 15\n").as_bytes()
    );
    assert_eq!(e.index("old.txt"), None);
}

#[test]
fn refuses_a_stale_selection() {
    let e = env();
    let old = numbered(10);
    e.commit_files(&[("f.txt", old.as_bytes())]);
    e.write("f.txt", old.replace("line 5\n", "LINE 5\n").as_bytes());
    let change = e.change(DiffTarget::Unstaged, "f.txt", None, |_, _| None);
    // The file changes after the diff was read.
    e.write("f.txt", old.replace("line 5\n", "other\n").as_bytes());
    let err = e.repos.stage_hunks(e.id, change.clone()).unwrap_err();
    assert_eq!(err.code, ErrorCode::StaleDiff);
    let err = e.repos.discard_hunks(e.id, change).unwrap_err();
    assert_eq!(err.code, ErrorCode::StaleDiff);
    assert_eq!(
        e.read("f.txt").unwrap(),
        old.replace("line 5\n", "other\n").as_bytes()
    );
    assert_eq!(e.index("f.txt").unwrap(), old.as_bytes());

    // Unknown hunk id on a current diff.
    let mut change = e.change(DiffTarget::Unstaged, "f.txt", None, |_, _| None);
    change.hunks[0].id = "-1,1+1,1".into();
    let err = e.repos.stage_hunks(e.id, change).unwrap_err();
    assert_eq!(err.code, ErrorCode::StaleDiff);

    // Whitespace-insensitive hunks do not describe the content.
    let mut change = e.change(DiffTarget::Unstaged, "f.txt", None, |_, _| None);
    change.options.ignore_whitespace = true;
    let err = e.repos.stage_hunks(e.id, change).unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
}

// ---- Discard ----------------------------------------------------------------------------

fn manifest(e: &Env, backup_id: &str) -> serde_json::Value {
    let dir = e.fx.root.join("backups").join(backup_id);
    serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).unwrap()).unwrap()
}

fn backup_file(e: &Env, backup_id: &str, file: &serde_json::Value) -> Vec<u8> {
    let name = file.as_str().unwrap();
    std::fs::read(e.fx.root.join("backups").join(backup_id).join(name)).unwrap()
}

#[test]
fn discarding_hunks_saves_the_file_first() {
    let e = env();
    let old = numbered(10);
    e.commit_files(&[("f.txt", old.as_bytes())]);
    let new = old
        .replace("line 2\n", "LINE 2\n")
        .replace("line 9\n", "LINE 9\n");
    e.write("f.txt", new.as_bytes());
    let (_, text) = e.diff(DiffTarget::Unstaged, "f.txt", None);
    let pick = lines_of(&text, 0, &[('-', "line 9"), ('+', "LINE 9")]);
    let change = e.change(DiffTarget::Unstaged, "f.txt", None, |_, _| {
        Some(pick.clone())
    });
    let result = e.repos.discard_hunks(e.id, change).unwrap();
    assert_eq!(
        e.read("f.txt").unwrap(),
        old.replace("line 2\n", "LINE 2\n").as_bytes()
    );
    let m = manifest(&e, &result.backup_id);
    assert_eq!(m["operation"], "discardHunks");
    assert_eq!(m["files"][0]["path"], "f.txt");
    assert_eq!(
        backup_file(&e, &result.backup_id, &m["files"][0]["worktree"]["file"]),
        new.as_bytes()
    );
}

#[test]
fn discarding_files_saves_their_content() {
    let e = env();
    e.write("README.md", b"edited\n");
    e.write("untracked.txt", b"draft\n");
    e.write("added.txt", b"staged\n");
    e.fx.git(&["add", "added.txt"]);

    let result = e
        .repos
        .discard_paths(e.id, paths(&["README.md", "untracked.txt"]), false)
        .unwrap();
    assert_eq!(e.read("README.md"), e.head("README.md"));
    assert_eq!(e.read("untracked.txt"), None);
    let m = manifest(&e, &result.backup_id);
    let files = m["files"].as_array().unwrap();
    assert_eq!(files.len(), 2);
    let saved = |path: &str| {
        let f = files.iter().find(|f| f["path"] == path).unwrap();
        backup_file(&e, &result.backup_id, &f["worktree"]["file"])
    };
    assert_eq!(saved("README.md"), b"edited\n");
    assert_eq!(saved("untracked.txt"), b"draft\n");

    // With the index: the added file goes away, its staged content is saved.
    let result = e
        .repos
        .discard_paths(e.id, PathSelection::All, true)
        .unwrap();
    assert_eq!(e.read("added.txt"), None);
    assert_eq!(e.index("added.txt"), None);
    let m = manifest(&e, &result.backup_id);
    let entry = m["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["path"] == "added.txt")
        .unwrap()
        .clone();
    assert_eq!(
        backup_file(&e, &result.backup_id, &entry["index"]["file"]),
        b"staged\n"
    );
    let (_, status) = e.git_out(&["status", "--porcelain"]);
    assert!(status.is_empty(), "{}", String::from_utf8_lossy(&status));
}

#[test]
fn discarding_staged_changes_resets_to_head() {
    let e = env();
    e.write("README.md", b"staged\n");
    e.fx.git(&["add", "README.md"]);
    e.write("README.md", b"staged and more\n");
    e.repos
        .discard_paths(e.id, paths(&["README.md"]), false)
        .unwrap();
    assert_eq!(e.read("README.md").unwrap(), b"staged\n");
    e.repos
        .discard_paths(e.id, paths(&["README.md"]), true)
        .unwrap();
    assert_eq!(e.read("README.md"), e.head("README.md"));
    assert_eq!(e.index("README.md"), e.head("README.md"));
}

// ---- Commit -----------------------------------------------------------------------------

#[test]
fn commits_amends_and_reads_the_message_back() {
    let e = env();
    let err = e.repos.commit(e.id, commit_request("nothing")).unwrap_err();
    assert_eq!(err.code, ErrorCode::NothingToCommit);
    let err = e.repos.commit(e.id, commit_request("  ")).unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);

    e.write("a.txt", b"a\n");
    e.repos.stage_paths(e.id, paths(&["a.txt"])).unwrap();
    let mut request = commit_request("Add a");
    request.description = "Why: tests.\n\nSecond paragraph.".into();
    let first = e.repos.commit(e.id, request).unwrap();
    let (_, head) = e.git_out(&["rev-parse", "HEAD"]);
    assert_eq!(String::from_utf8(head).unwrap().trim(), first.sha);
    let message = e.repos.last_commit_message(e.id).unwrap().unwrap();
    assert_eq!(message.summary, "Add a");
    assert_eq!(message.description, "Why: tests.\n\nSecond paragraph.");

    let mut amend = commit_request("Add a (amended)");
    amend.amend = true;
    let second = e.repos.commit(e.id, amend).unwrap();
    assert_ne!(first.sha, second.sha);
    let (_, parent) = e.git_out(&["rev-parse", "HEAD~1"]);
    let (_, before) = e.git_out(&["rev-parse", &format!("{}~1", first.sha)]);
    assert_eq!(parent, before);
    assert_eq!(
        e.repos.last_commit_message(e.id).unwrap().unwrap().summary,
        "Add a (amended)"
    );
}

#[test]
fn reports_an_unknown_identity() {
    let e = env();
    e.fx.git(&["config", "--unset", "user.name"]);
    e.fx.git(&["config", "--unset", "user.email"]);
    e.fx.git(&["config", "user.useConfigOnly", "true"]);
    let identity = e.repos.git_identity(e.id).unwrap();
    assert_eq!((identity.name, identity.email), (None, None));
    e.write("a.txt", b"a\n");
    e.repos.stage_paths(e.id, paths(&["a.txt"])).unwrap();
    let err = e.repos.commit(e.id, commit_request("Add a")).unwrap_err();
    assert_eq!(err.code, ErrorCode::IdentityUnknown);

    e.repos
        .set_git_identity(e.id, "Ada Lovelace", "ada@example.com", ConfigScope::Repo)
        .unwrap();
    let identity = e.repos.git_identity(e.id).unwrap();
    assert_eq!(identity.name.as_deref(), Some("Ada Lovelace"));
    assert_eq!(identity.email.as_deref(), Some("ada@example.com"));
    e.repos.commit(e.id, commit_request("Add a")).unwrap();
    let err = e
        .repos
        .set_git_identity(e.id, "x\ny", "a@b", ConfigScope::Repo)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
}

#[cfg(unix)]
fn install_hook(e: &Env, name: &str, script: &str) {
    use std::os::unix::fs::PermissionsExt;
    let path = e.fx.repo().join(".git/hooks").join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, script).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
#[test]
fn a_failing_hook_reports_its_full_output() {
    let e = env();
    let long: String = (0..2_000).map(|i| format!("problem {i}\n")).collect();
    install_hook(
        &e,
        "pre-commit",
        &format!("#!/bin/sh\necho checking\ncat >&2 <<'EOF'\n{long}EOF\nexit 3\n"),
    );
    e.write("a.txt", b"a\n");
    e.repos.stage_paths(e.id, paths(&["a.txt"])).unwrap();
    let err = e.repos.commit(e.id, commit_request("Add a")).unwrap_err();
    assert_eq!(err.code, ErrorCode::HookFailed);
    match err.payload.as_deref() {
        Some(ErrorPayload::Hook {
            hook,
            exit_code,
            stdout,
            stderr,
            truncated,
        }) => {
            assert_eq!(hook.as_deref(), Some("pre-commit"));
            assert!(!truncated);
            // Git's own code: it exits with 1 whatever the hook returned.
            assert_eq!(*exit_code, Some(1));
            // Git sends a hook's stdout to stderr; nothing is truncated.
            assert_eq!(stdout, "");
            assert_eq!(stderr, &format!("checking\n{long}"));
        }
        other => panic!("expected a hook payload, got {other:?}"),
    }
    // Skipping the hooks commits.
    let mut request = commit_request("Add a");
    request.skip_hooks = true;
    e.repos.commit(e.id, request).unwrap();
}

#[cfg(unix)]
#[test]
fn a_runaway_hook_output_keeps_its_beginning_and_end() {
    let e = env();
    // ~6 MB on stderr, more than the 2 MiB kept per stream.
    install_hook(
        &e,
        "pre-commit",
        "#!/bin/sh\necho first line >&2\nyes 'noise noise noise noise noise noise' | head -n 150000 >&2\necho last line >&2\nexit 1\n",
    );
    e.write("a.txt", b"a\n");
    e.repos.stage_paths(e.id, paths(&["a.txt"])).unwrap();
    let err = e.repos.commit(e.id, commit_request("Add a")).unwrap_err();
    match err.payload.as_deref() {
        Some(ErrorPayload::Hook {
            stderr, truncated, ..
        }) => {
            assert!(*truncated);
            assert!(stderr.len() <= 2 * 1024 * 1024 + 16, "{}", stderr.len());
            assert!(stderr.starts_with("first line\n"));
            assert!(stderr.ends_with("last line\n"));
            assert!(stderr.contains("\n[...]\n"));
        }
        other => panic!("expected a hook payload, got {other:?}"),
    }
}

#[cfg(unix)]
#[test]
fn cancelling_a_commit_kills_the_hook_and_its_children() {
    let e = env();
    install_hook(
        &e,
        "pre-commit",
        "#!/bin/sh\nsleep 60 &\necho $! > hook-child.pid\nwait\n",
    );
    e.write("a.txt", b"a\n");
    e.repos.stage_paths(e.id, paths(&["a.txt"])).unwrap();
    e.sink.clear();

    let repos = Arc::clone(&e.repos);
    let id = e.id;
    let commit = std::thread::spawn(move || repos.commit(id, commit_request("Add a")));
    let pid_file = e.fx.repo().join("hook-child.pid");
    assert!(wait_until(Duration::from_secs(10), || {
        std::fs::read_to_string(&pid_file).is_ok_and(|s| s.ends_with('\n'))
    }));
    let op_id = e
        .sink
        .events()
        .iter()
        .find_map(|ev| match ev {
            BackendEvent::OpStarted(s) if s.kind == OpKind::Commit => {
                assert!(s.cancellable);
                Some(s.op_id)
            }
            _ => None,
        })
        .unwrap();
    e.repos.cancel_op(op_id).unwrap();
    let err = commit.join().unwrap().unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);

    let pid = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .to_owned();
    assert!(
        wait_until(Duration::from_secs(5), || !alive(&pid)),
        "hook child {pid} still running"
    );
    // Git removed its lock: the next commit works.
    assert!(!e.fx.repo().join(".git/index.lock").exists());
    std::fs::remove_file(e.fx.repo().join(".git/hooks/pre-commit")).unwrap();
    std::fs::remove_file(&pid_file).unwrap();
    e.repos.commit(e.id, commit_request("Add a")).unwrap();
}

#[cfg(unix)]
fn alive(pid: &str) -> bool {
    // A zombie still answers `kill -0`: look at its state too.
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"));
    if let Ok(stat) = stat {
        return !stat.contains(") Z ");
    }
    std::process::Command::new("kill")
        .args(["-0", pid])
        .status()
        .is_ok_and(|s| s.success())
}

fn wait_until(timeout: Duration, mut done: impl FnMut() -> bool) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if done() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

#[test]
fn backups_live_under_the_configured_folder() {
    let e = env();
    e.write("x.txt", b"x\n");
    let result = e
        .repos
        .discard_paths(e.id, paths(&["x.txt"]), false)
        .unwrap();
    assert!(Path::new(&e.fx.root.join("backups").join(&result.backup_id)).is_dir());
}

// ---- Edge cases from the review --------------------------------------------------------

#[test]
fn refuses_folders_dots_and_nul_in_paths() {
    let e = env();
    e.write("dir/a.txt", b"a\n");
    e.write("dir/b.txt", b"b\n");
    for bad in [".", "dir/", "./dir", "dir/./a.txt", "a\0b"] {
        let err = e
            .repos
            .discard_paths(e.id, paths(&[bad]), false)
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidArgument, "{bad:?}");
    }
    let err = e
        .repos
        .discard_paths(e.id, paths(&["dir"]), false)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    assert!(e.read("dir/a.txt").is_some() && e.read("dir/b.txt").is_some());
}

#[test]
fn unstaging_everything_keeps_an_ongoing_merge() {
    let e = env();
    e.commit_files(&[("m.txt", b"base\n")]);
    e.fx.git(&["checkout", "-q", "-b", "other"]);
    e.commit_files(&[("m.txt", b"other\n")]);
    e.fx.git(&["checkout", "-q", "-"]);
    e.commit_files(&[("m.txt", b"ours\n"), ("x.txt", b"x\n")]);
    let status = std::process::Command::new("git")
        .args(["merge", "-q", "other"])
        .current_dir(e.fx.repo())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap()
        .status;
    assert!(!status.success(), "the merge conflicts");
    e.write("x.txt", b"x2\n");
    e.fx.git(&["add", "x.txt"]);
    e.repos.unstage_paths(e.id, PathSelection::All).unwrap();
    assert!(e.fx.repo().join(".git/MERGE_HEAD").exists());
    assert_eq!(e.index("x.txt").unwrap(), b"x\n");
}

#[test]
fn unborn_branch_amend_and_discard() {
    let e = env_with("unborn");
    let mut amend = commit_request("Amend");
    amend.amend = true;
    let err = e.repos.commit(e.id, amend).unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);

    // Staged, then edited again: both versions are saved, then the file goes away.
    e.write("s.txt", b"staged\n");
    e.fx.git(&["add", "s.txt"]);
    e.write("s.txt", b"edited\n");
    let result = e
        .repos
        .discard_paths(e.id, paths(&["s.txt"]), true)
        .unwrap();
    assert_eq!(e.read("s.txt"), None);
    assert_eq!(e.index("s.txt"), None);
    let m = manifest(&e, &result.backup_id);
    let entry = &m["files"][0];
    assert_eq!(
        backup_file(&e, &result.backup_id, &entry["worktree"]["file"]),
        b"edited\n"
    );
    assert_eq!(
        backup_file(&e, &result.backup_id, &entry["index"]["file"]),
        b"staged\n"
    );
}

#[cfg(unix)]
#[test]
fn a_hook_failure_is_not_claimed_for_git_errors() {
    let e = env();
    install_hook(&e, "pre-commit", "#!/bin/sh\nexit 0\n");
    e.write("a.txt", b"a\n");
    e.repos.stage_paths(e.id, paths(&["a.txt"])).unwrap();
    // Git itself fails (exit 128): not reported as the hook's fault.
    e.fx.git(&["config", "commit.gpgSign", "true"]);
    e.fx.git(&["config", "gpg.program", "/nonexistent/gpg"]);
    let err = e.repos.commit(e.id, commit_request("Add a")).unwrap_err();
    assert_ne!(err.code, ErrorCode::HookFailed);
}

#[cfg(unix)]
#[test]
fn a_post_commit_hook_left_running_does_not_block_the_commit() {
    let e = env();
    install_hook(&e, "post-commit", "#!/bin/sh\nsleep 30 &\n");
    e.write("a.txt", b"a\n");
    e.repos.stage_paths(e.id, paths(&["a.txt"])).unwrap();
    let start = std::time::Instant::now();
    e.repos.commit(e.id, commit_request("Add a")).unwrap();
    assert!(start.elapsed() < Duration::from_secs(10));
}

/// A discard patch is applied to the working tree by `git apply`, after the file was read and
/// checked: it carries the whole file as context, so an edit saved in between makes git
/// refuse it instead of applying it at shifted lines.
#[test]
fn a_discard_patch_refuses_a_file_changed_after_its_check() {
    use yaggui_lib::git::ops::patch::{self, Direction, PatchInput, PatchSide};
    use yaggui_lib::git::ops::types::HunkSelection;
    use yaggui_lib::git::read::diff::text::hunk_spans;
    use yaggui_lib::git::read::diff::types::DiffOptions;

    let old: String = (1..=30).map(|i| format!("line {i}\n")).collect();
    let new = old.replace("line 20\n", "line twenty\n");
    for context_lines in [0, 3] {
        let options = DiffOptions {
            context_lines,
            ..DiffOptions::default()
        };
        let spans = hunk_spans(
            old.as_bytes(),
            new.as_bytes(),
            gix::diff::blob::Algorithm::Histogram,
            &options,
        );
        let side = |c: &'static str| PatchSide {
            content: c.as_bytes(),
            mode: "100644",
        };
        let (old, new): (&'static str, &'static str) =
            (Box::leak(old.clone().into()), Box::leak(new.clone().into()));
        let input = PatchInput {
            path: "f.txt",
            old: Some(side(old)),
            new: Some(side(new)),
            spans: &spans,
        };
        let selection = vec![HunkSelection {
            id: spans[0].id.clone(),
            lines: None,
        }];
        let (whole_spans, whole_selection) = patch::whole_file(&input, &selection).unwrap();
        let whole = PatchInput {
            spans: &whole_spans,
            ..input
        };
        let built = patch::build(&whole, &whole_selection, Direction::Reverse)
            .unwrap()
            .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let apply = |content: &str| {
            std::fs::write(dir.path().join("f.txt"), content).unwrap();
            let mut child = std::process::Command::new("git")
                .args(["apply", "--reverse", "-"])
                .current_dir(dir.path())
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            use std::io::Write as _;
            child.stdin.take().unwrap().write_all(&built).unwrap();
            child.wait().unwrap().success()
        };
        // Lines inserted at the top (an editor save) shift the hunk: refused.
        assert!(
            !apply(&format!("inserted\n{new}")),
            "context {context_lines}"
        );
        // Edited anywhere before its end: refused too.
        assert!(!apply(&new.replace("line 2\n", "line 2 edited\n")));
        assert!(!apply(&new.replace("line 29\n", "line 29 edited\n")));
        // Unchanged: discarded.
        assert!(apply(new), "context {context_lines}");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.txt")).unwrap(),
            old
        );
        // Lines appended after the last one shift nothing: git applies the discard in place
        // and keeps them.
        assert!(
            apply(&format!("{new}appended\n")),
            "context {context_lines}"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.txt")).unwrap(),
            format!("{old}appended\n")
        );
    }
}

/// The front reports operation errors from `op-finished`: every failure of an operation,
/// validation included, and every cancellation emits it.
#[test]
fn every_failed_or_cancelled_operation_emits_op_finished() {
    use yaggui_lib::events::OpOutcome;

    let e = env();
    let finished = |e: &Env| -> Vec<(OpKind, OpOutcome)> {
        e.sink
            .events()
            .into_iter()
            .filter_map(|ev| match ev {
                BackendEvent::OpFinished(f) => Some((f.kind, f.outcome)),
                _ => None,
            })
            .collect()
    };
    let failed = |outcome: &OpOutcome, code: ErrorCode| matches!(outcome, OpOutcome::Failed { error } if error.code == code);

    e.sink.clear();
    let err = e
        .repos
        .stage_paths(e.id, paths(&["../outside"]))
        .unwrap_err();
    let events = finished(&e);
    assert_eq!(events.len(), 1);
    assert!(failed(&events[0].1, err.code), "{events:?}");

    e.sink.clear();
    let err = e
        .repos
        .set_git_identity(e.id, "", "a@b", ConfigScope::Repo)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    let events = finished(&e);
    assert_eq!(events.len(), 1);
    assert!(failed(&events[0].1, ErrorCode::InvalidArgument));

    e.sink.clear();
    let err = e.repos.commit(e.id, commit_request("Nothing")).unwrap_err();
    let events = finished(&e);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].0, OpKind::Commit);
    assert!(failed(&events[0].1, err.code));

    // Cancelled before it ran (queued behind a slow operation).
    e.sink.clear();
    let session = e.repos.session(e.id).unwrap();
    let (release, wait) = std::sync::mpsc::channel::<()>();
    let blocker = session
        .queue()
        .enqueue(OpKind::Maintenance, false, move |_| {
            let _ = wait.recv_timeout(Duration::from_secs(5));
            Ok(())
        })
        .unwrap();
    let queued = session
        .queue()
        .enqueue(OpKind::Stage, true, |_| Ok(()))
        .unwrap();
    assert!(e.repos.cancel_op(queued.op_id).is_ok());
    release.send(()).unwrap();
    blocker.wait().unwrap();
    assert_eq!(queued.wait().unwrap_err().code, ErrorCode::Cancelled);
    let events = finished(&e);
    assert_eq!(events.len(), 2);
    assert!(matches!(
        events[0],
        (OpKind::Maintenance, OpOutcome::Success { .. })
    ));
    assert!(matches!(events[1], (OpKind::Stage, OpOutcome::Cancelled)));
}

// ---- Windows settings, simulated (see also tests/platform.rs) -----------------------------

fn unstaged(e: &Env) -> Vec<(String, Option<u32>, Option<u32>)> {
    e.repos
        .changed_files(e.id, &DiffTarget::Unstaged)
        .unwrap()
        .files
        .into_iter()
        .map(|f| (f.path, f.additions, f.deletions))
        .collect()
}

/// `core.autocrlf=true` (Git for Windows default): CRLF on disk, LF in the index. Hunks are
/// staged and discarded through the conversion.
#[test]
fn autocrlf_converts_line_endings_both_ways() {
    let e = env();
    e.fx.git(&["config", "core.autocrlf", "true"]);
    e.commit_files(&[("crlf.txt", b"one\ntwo\nthree\nfour\n")]);
    assert_eq!(e.head("crlf.txt").unwrap(), b"one\ntwo\nthree\nfour\n");

    // Only converted: Git itself still lists it until the index is refreshed (`git status`
    // says ` M`, `git diff` is empty). yaggui agrees, with no changed line.
    e.write("crlf.txt", b"one\r\ntwo\r\nthree\r\nfour\r\n");
    let (_, porcelain) = e.git_out(&["status", "--porcelain"]);
    let listed_by_git = !porcelain.is_empty();
    let ours = unstaged(&e);
    assert_eq!(!ours.is_empty(), listed_by_git, "{ours:?}");
    assert!(
        ours.iter()
            .all(|(_, add, del)| *add == Some(0) && *del == Some(0))
    );

    e.write("crlf.txt", b"ONE\r\ntwo\r\nthree\r\nFOUR\r\n");
    assert_eq!(unstaged(&e), [("crlf.txt".to_owned(), Some(2), Some(2))]);
    // Stage the first change only (no context: two hunks): the index gets LF.
    let change = e.change(DiffTarget::Unstaged, "crlf.txt", None, |_, _| None);
    let change = HunkChange {
        options: DiffOptions {
            context_lines: 0,
            ..DiffOptions::default()
        },
        ..change
    };
    let (diff, text) = {
        let repo = gix::open(e.fx.repo()).unwrap();
        let diff = file_diff(
            &repo,
            &DiffTarget::Unstaged,
            "crlf.txt",
            None,
            &change.options,
        )
        .unwrap();
        let DiffContent::Text(text) = diff.content.clone() else {
            panic!("expected text")
        };
        (diff, text)
    };
    assert_eq!(text.hunks.len(), 2);
    let first = HunkChange {
        old_id: diff.old_id.clone(),
        new_id: diff.new_id.clone(),
        hunks: vec![HunkSelection {
            id: text.hunks[0].id.clone(),
            lines: None,
        }],
        ..change
    };
    e.repos.stage_hunks(e.id, first).unwrap();
    assert_eq!(e.index("crlf.txt").unwrap(), b"ONE\ntwo\nthree\nfour\n");
    // Discard the other one: the working tree keeps CRLF.
    let rest = e.change(DiffTarget::Unstaged, "crlf.txt", None, |_, _| None);
    e.repos.discard_hunks(e.id, rest).unwrap();
    assert_eq!(
        e.read("crlf.txt").unwrap(),
        b"ONE\r\ntwo\r\nthree\r\nfour\r\n"
    );
    let (_, diff) = e.git_out(&["diff"]);
    assert!(diff.is_empty(), "{}", String::from_utf8_lossy(&diff));
}

/// `core.fileMode=false` (Windows, and FAT/NTFS mounts elsewhere): the executable bit on
/// disk means nothing; the index mode is kept.
#[cfg(unix)]
#[test]
fn file_mode_false_ignores_the_executable_bit() {
    use std::os::unix::fs::PermissionsExt;
    let e = env();
    e.commit_files(&[("run.sh", b"echo 1\n")]);
    e.fx.git(&["config", "core.fileMode", "false"]);
    let path = e.fx.repo().join("run.sh");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(unstaged(&e).is_empty(), "{:?}", unstaged(&e));

    e.write("run.sh", b"echo 2\n");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let files = e
        .repos
        .changed_files(e.id, &DiffTarget::Unstaged)
        .unwrap()
        .files;
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].old_mode, files[0].new_mode, "{:?}", files[0]);
    let change = e.change(DiffTarget::Unstaged, "run.sh", None, |_, _| None);
    e.repos.stage_hunks(e.id, change).unwrap();
    let (_, ls) = e.git_out(&["ls-files", "-s", "run.sh"]);
    assert!(String::from_utf8_lossy(&ls).starts_with("100644 "));
}

/// Paths beyond Windows' 260 characters (`core.longpaths`): read, staged, committed.
#[test]
fn long_paths_are_read_and_written() {
    let e = env();
    let dir: Vec<String> = (0..12)
        .map(|i| format!("folder-with-a-long-name-{i:02}"))
        .collect();
    let path = format!("{}/file-with-a-long-name.txt", dir.join("/"));
    assert!(e.fx.repo().join(&path).to_string_lossy().len() > 300);
    e.write(&path, b"long\n");
    assert_eq!(unstaged(&e), [(path.clone(), Some(1), Some(0))]);
    e.repos.stage_paths(e.id, paths(&[&path])).unwrap();
    e.repos.commit(e.id, commit_request("Long path")).unwrap();
    assert_eq!(e.head(&path).unwrap(), b"long\n");
}
