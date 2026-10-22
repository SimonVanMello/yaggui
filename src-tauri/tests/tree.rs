//! Tree at a commit (M7-8, F-224) on the `tree` fixture: lazy folder listings with paging,
//! file contents of every kind, versions at older commits, and saving a version.

mod common;

use std::process::Command;
use std::sync::Arc;

use common::{Fixture, RecordingSink};
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::errors::ErrorCode;
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::read::diff::types::TextEncoding;
use yaggui_lib::git::read::tree::{TreeEntryKind, TreeFileContent, TreePage};
use yaggui_lib::repo::RepoManager;
use yaggui_lib::store::Store;

struct Env {
    fx: Fixture,
    repos: Arc<RepoManager>,
    id: u32,
}

fn env() -> Env {
    let fx = Fixture::new("tree");
    let sink = Arc::new(RecordingSink::default());
    let git = GitCli::new(Arc::new(CommandLog::new()), sink.clone());
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
    fn sha(&self, rev: &str) -> String {
        let output = Command::new("git")
            .args(["rev-parse", rev])
            .current_dir(self.fx.repo())
            .output()
            .unwrap();
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    fn list(&self, rev: &str, path: &str, start: u32, limit: u32) -> TreePage {
        self.repos
            .tree_list(self.id, rev, path, start, limit)
            .unwrap()
    }

    fn names(&self, rev: &str, path: &str) -> Vec<String> {
        self.list(rev, path, 0, 500)
            .entries
            .into_iter()
            .map(|entry| entry.name)
            .collect()
    }
}

#[test]
fn lists_the_root_folders_first_then_by_name() {
    let env = env();
    let page = env.list("HEAD", "", 0, 500);
    assert_eq!(page.rev, env.sha("HEAD"));
    assert_eq!(page.path, "");
    let names: Vec<_> = page.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "docs",
            "libs",
            "many",
            "src",
            ".gitattributes",
            "README.md",
            "run.sh"
        ]
    );
    assert_eq!(page.total, 7);
    let kinds: Vec<_> = page.entries.iter().map(|e| e.kind).collect();
    assert_eq!(kinds[0], TreeEntryKind::Dir);
    assert_eq!(kinds[6], TreeEntryKind::Executable);
    let readme = &page.entries[5];
    assert_eq!(readme.kind, TreeEntryKind::File);
    assert_eq!(readme.size, Some(9.0));
    assert_eq!(page.entries[0].size, None);
}

#[test]
fn lists_a_nested_folder_with_every_entry_kind() {
    let env = env();
    let page = env.list("HEAD", "docs", 0, 500);
    let by_name = |name: &str| page.entries.iter().find(|e| e.name == name).unwrap();
    assert_eq!(by_name("readme-link").kind, TreeEntryKind::Symlink);
    assert_eq!(by_name("readme-link").size, Some(12.0));
    assert_eq!(by_name("logo.png").kind, TreeEntryKind::File);
    assert_eq!(env.names("HEAD", "src/deep/er"), ["leaf.txt"]);
    let libs = env.list("HEAD", "libs", 0, 500);
    assert_eq!(libs.entries[0].kind, TreeEntryKind::Submodule);
    assert_eq!(libs.entries[0].size, None);
    assert_eq!(libs.entries[0].oid, "1".repeat(40));
}

#[test]
fn pages_a_large_folder() {
    let env = env();
    let first = env.list("HEAD", "many", 0, 500);
    assert_eq!(first.total, 1200);
    assert_eq!(first.entries.len(), 500);
    assert_eq!(first.entries[0].name, "f0000.txt");
    let last = env.list("HEAD", "many", 1000, 500);
    assert_eq!(last.entries.len(), 200);
    assert_eq!(last.entries[199].name, "f1199.txt");
    // A page never exceeds 500 entries, whatever is asked.
    assert_eq!(env.list("HEAD", "many", 0, 100_000).entries.len(), 500);
    assert!(env.list("HEAD", "many", 5000, 500).entries.is_empty());
}

#[test]
fn reads_an_older_commit() {
    let env = env();
    let first = env.sha("HEAD~2");
    assert!(env.names(&first, "docs").contains(&"blob.bin".to_owned()));
    assert!(!env.names("HEAD", "docs").contains(&"blob.bin".to_owned()));
    assert!(!env.names(&first, "").contains(&"libs".to_owned()));
    let old = env
        .repos
        .tree_file(env.id, &first, "src/main.rs", false)
        .unwrap();
    let new = env
        .repos
        .tree_file(env.id, "HEAD", "src/main.rs", false)
        .unwrap();
    assert_eq!(
        old.content,
        TreeFileContent::Text {
            text: "fn main() {}\n".into(),
            encoding: TextEncoding::Utf8
        }
    );
    assert!(matches!(&new.content, TreeFileContent::Text { text, .. } if text.contains("v2")));
    assert_ne!(old.oid, new.oid);
    assert_eq!(old.rev, first);
}

#[test]
fn rejects_bad_revisions_and_paths() {
    let env = env();
    let code = |err: yaggui_lib::git::errors::YagguiError| err.code;
    let list = |rev: &str, path: &str| env.repos.tree_list(env.id, rev, path, 0, 10);
    assert_eq!(
        code(list("nope", "").unwrap_err()),
        ErrorCode::RevisionNotFound
    );
    assert_eq!(
        code(list("--all", "").unwrap_err()),
        ErrorCode::RevisionNotFound
    );
    // A file is not a folder, a missing folder does not exist, `..` leaves the repository.
    assert_eq!(
        code(list("HEAD", "README.md").unwrap_err()),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        code(list("HEAD", "missing").unwrap_err()),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        code(list("HEAD", "../x").unwrap_err()),
        ErrorCode::InvalidArgument
    );
    let file = |path: &str| env.repos.tree_file(env.id, "HEAD", path, false);
    assert_eq!(code(file("docs").unwrap_err()), ErrorCode::InvalidArgument);
    assert_eq!(
        code(file("docs/blob.bin").unwrap_err()),
        ErrorCode::InvalidArgument
    );
    assert_eq!(code(file("").unwrap_err()), ErrorCode::InvalidArgument);
}

#[test]
fn shows_each_kind_of_file() {
    let env = env();
    let file = |path: &str, force: bool| {
        env.repos
            .tree_file(env.id, "HEAD", path, force)
            .unwrap_or_else(|err| panic!("{path}: {err:?}"))
    };
    // Latin-1 text is decoded, flagged as a guess.
    assert_eq!(
        file("docs/latin1.txt", false).content,
        TreeFileContent::Text {
            text: "café\n".into(),
            encoding: TextEncoding::Windows1252
        }
    );
    // A PNG goes to the webview as a data URL.
    let TreeFileContent::Image { url: data_url } = file("docs/logo.png", false).content else {
        panic!("expected an image");
    };
    assert!(data_url.starts_with("data:image/png;base64,iVBORw0KGgo"));
    // Executable bit.
    assert!(file("run.sh", false).executable);
    assert!(!file("README.md", false).executable);
    // A symlink shows its target, not the file it points to.
    assert_eq!(
        file("docs/readme-link", false).content,
        TreeFileContent::Symlink {
            target: "../README.md".into()
        }
    );
    // A submodule shows its commit and has no content.
    assert_eq!(
        file("libs/sub", false).content,
        TreeFileContent::Submodule {
            commit: "1".repeat(40)
        }
    );
    // An LFS pointer is recognized, not shown as text.
    let TreeFileContent::Lfs { object } = file("docs/model.lfs", false).content else {
        panic!("expected an LFS pointer");
    };
    assert_eq!(object.size, 4096.0);
    // A text above the render limit is only read when forced.
    let big = file("docs/big.txt", false);
    assert_eq!(big.size, 1_200_000.0);
    assert!(matches!(big.content, TreeFileContent::TooLarge { .. }));
    let TreeFileContent::Text { text, .. } = file("docs/big.txt", true).content else {
        panic!("expected the forced text");
    };
    assert_eq!(text.len(), 1_200_000);
    // A binary is not decoded.
    let first = env.sha("HEAD~2");
    assert_eq!(
        env.repos
            .tree_file(env.id, &first, "docs/blob.bin", false)
            .unwrap()
            .content,
        TreeFileContent::Binary
    );
}

#[test]
fn saves_a_version_without_replacing_by_surprise() {
    let env = env();
    let first = env.sha("HEAD~2");
    let out = env.fx.root.join("saved");
    std::fs::create_dir(&out).unwrap();
    let dest = out.join("main-old.rs");
    env.repos
        .tree_save(env.id, &first, "src/main.rs", &dest, false)
        .unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), b"fn main() {}\n");

    // Same destination: refused, and the file is untouched.
    let err = env
        .repos
        .tree_save(env.id, "HEAD", "src/main.rs", &dest, false)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    assert_eq!(std::fs::read(&dest).unwrap(), b"fn main() {}\n");
    // Confirmed replacement.
    env.repos
        .tree_save(env.id, "HEAD", "src/main.rs", &dest, true)
        .unwrap();
    assert!(std::fs::read_to_string(&dest).unwrap().contains("println!"));
    // No temporary file is left behind.
    assert_eq!(std::fs::read_dir(&out).unwrap().count(), 1);

    // The bytes are the blob's, binary included; a symlink saves its target text.
    let blob = out.join("blob.bin");
    env.repos
        .tree_save(env.id, &first, "docs/blob.bin", &blob, false)
        .unwrap();
    assert_eq!(std::fs::read(&blob).unwrap(), b"a\0b\0");
    let link = out.join("link.txt");
    env.repos
        .tree_save(env.id, "HEAD", "docs/readme-link", &link, false)
        .unwrap();
    assert_eq!(std::fs::read(&link).unwrap(), b"../README.md");

    // A submodule has nothing to save; the working tree is never touched.
    let sub = out.join("sub");
    let err = env
        .repos
        .tree_save(env.id, "HEAD", "libs/sub", &sub, false)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    assert!(!sub.exists());
}

/// P-type measurement, `cargo test --release --test tree tree_bench -- --ignored --nocapture`
/// on the `wide` fixture or any repo (`YAGGUI_BENCH_REPO=<worktree>`,
/// `YAGGUI_BENCH_DIR=<folder>` for the folder to list, default the root).
#[test]
#[ignore = "benchmark"]
fn tree_bench() {
    let fx;
    let path = match std::env::var("YAGGUI_BENCH_REPO") {
        Ok(path) => path,
        Err(_) => {
            fx = Fixture::new("wide");
            fx.repo_str()
        }
    };
    let dir = std::env::var("YAGGUI_BENCH_DIR").unwrap_or_default();
    let sink = Arc::new(RecordingSink::default());
    let git = GitCli::new(Arc::new(CommandLog::new()), sink.clone());
    let store = Arc::new(Store::open_in_memory().unwrap());
    let repos = RepoManager::new(Arc::new(git), store, sink).without_watcher();
    let id = repos.open(&path).unwrap().id;
    let timed = |label: &str, start: u32| {
        let t = std::time::Instant::now();
        let page = repos.tree_list(id, "HEAD", &dir, start, 500).unwrap();
        println!(
            "{label}: {:?} ({} of {} entries)",
            t.elapsed(),
            page.entries.len(),
            page.total
        );
        page
    };
    let first = timed("first page", 0);
    timed("middle page", first.total / 2);
    timed("last page", first.total.saturating_sub(500));
    let t = std::time::Instant::now();
    let mut start = 0;
    while start < first.total {
        start += 500;
        repos.tree_list(id, "HEAD", &dir, start - 500, 500).unwrap();
    }
    println!("whole folder, {} pages: {:?}", start / 500, t.elapsed());
}
