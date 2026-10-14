//! Changed files and file diffs, on the generated `diff` fixture.

mod common;

use common::{Fixture, backend};
use yaggui_lib::git::errors::ErrorCode;
use yaggui_lib::git::read::diff::types::{
    ChangedFile, DiffContent, DiffOptions, DiffTarget, FileMode, FileStatus, LineEnding, TextDiff,
    TextEncoding,
};
use yaggui_lib::git::read::diff::{changed_files, file_diff};

fn open(fx: &Fixture) -> gix::Repository {
    gix::open(fx.repo()).expect("open fixture")
}

fn head() -> DiffTarget {
    DiffTarget::Commits {
        from: None,
        to: "HEAD".into(),
    }
}

fn find<'a>(files: &'a [ChangedFile], path: &str) -> &'a ChangedFile {
    files
        .iter()
        .find(|f| f.path == path)
        .unwrap_or_else(|| panic!("{path} not in {files:#?}"))
}

fn text(content: DiffContent) -> TextDiff {
    match content {
        DiffContent::Text(text) => text,
        other => panic!("expected a text diff, got {other:?}"),
    }
}

#[test]
fn commit_files_cover_every_kind_of_change() {
    let fx = Fixture::new("diff");
    let repo = open(&fx);
    let list = changed_files(&repo, &head()).unwrap();
    assert!(!list.stats_skipped);
    let paths: Vec<_> = list.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "assets/logo.png",
            "big.txt",
            "crlf.txt",
            "docs/added.md",
            "docs/remove.md",
            "generated.json",
            "latin1.txt",
            "libs/sub",
            "run.sh",
            "src/app.ts",
            "src/new_name.ts",
        ]
    );

    let app = find(&list.files, "src/app.ts");
    assert_eq!(app.status, FileStatus::Modified);
    assert_eq!((app.additions, app.deletions), (Some(2), Some(2)));

    let renamed = find(&list.files, "src/new_name.ts");
    assert_eq!(renamed.status, FileStatus::Renamed);
    assert_eq!(renamed.old_path.as_deref(), Some("src/old_name.ts"));
    assert_eq!(renamed.similarity, Some(87));
    assert_eq!((renamed.additions, renamed.deletions), (Some(2), Some(2)));

    assert_eq!(find(&list.files, "docs/added.md").status, FileStatus::Added);
    assert_eq!(
        find(&list.files, "docs/remove.md").status,
        FileStatus::Deleted
    );
    assert_eq!(find(&list.files, "generated.json").additions, Some(6000));

    let png = find(&list.files, "assets/logo.png");
    assert!(png.binary);
    assert_eq!(png.additions, None);

    let script = find(&list.files, "run.sh");
    assert_eq!(script.old_mode, Some(FileMode::Regular));
    assert_eq!(script.new_mode, Some(FileMode::Executable));
    assert_eq!((script.additions, script.deletions), (Some(0), Some(0)));

    // A multi-megabyte file is never loaded for stats.
    let big = find(&list.files, "big.txt");
    assert_eq!(
        (big.additions, big.deletions, big.binary),
        (None, None, false)
    );

    let sub = find(&list.files, "libs/sub");
    assert_eq!(sub.new_mode, Some(FileMode::Submodule));
    assert_eq!(sub.additions, None);
}

#[test]
fn commit_range_and_root_commit() {
    let fx = Fixture::new("diff");
    let repo = open(&fx);
    // The root commit is compared with the empty tree.
    let root = changed_files(
        &repo,
        &DiffTarget::Commits {
            from: None,
            to: "HEAD~1".into(),
        },
    )
    .unwrap();
    assert!(root.files.iter().all(|f| f.status == FileStatus::Added));
    assert_eq!(root.files.len(), 9);

    let range = changed_files(
        &repo,
        &DiffTarget::Commits {
            from: Some("HEAD".into()),
            to: "HEAD~1".into(),
        },
    )
    .unwrap();
    assert_eq!(
        find(&range.files, "docs/remove.md").status,
        FileStatus::Added
    );
}

#[test]
fn text_diff_with_hunks_and_line_numbers() {
    let fx = Fixture::new("diff");
    let repo = open(&fx);
    let diff = file_diff(&repo, &head(), "src/app.ts", None, &DiffOptions::default()).unwrap();
    assert_eq!(diff.old_mode, Some(FileMode::Regular));
    assert!(diff.old_id.is_some() && diff.new_id.is_some());
    let text = text(diff.content);
    assert_eq!(text.hunks.len(), 1);
    let hunk = &text.hunks[0];
    assert_eq!(
        (
            hunk.old_start,
            hunk.old_lines,
            hunk.new_start,
            hunk.new_lines
        ),
        (1, 4, 1, 4)
    );
    assert_eq!(hunk.kinds, "-+ -+ ");
    assert_eq!(hunk.lines[1], "export const a = 2;");
}

#[test]
fn rename_diff_reads_the_old_path() {
    let fx = Fixture::new("diff");
    let repo = open(&fx);
    let diff = file_diff(
        &repo,
        &head(),
        "src/new_name.ts",
        Some("src/old_name.ts"),
        &DiffOptions::default(),
    )
    .unwrap();
    let text = text(diff.content);
    assert_eq!((text.additions, text.deletions), (2, 2));
    assert_eq!(text.hunks.len(), 1);
}

#[test]
fn binary_large_submodule_and_mode_changes() {
    let fx = Fixture::new("diff");
    let repo = open(&fx);
    let options = DiffOptions::default();
    let diff =
        |path: &str, options: &DiffOptions| file_diff(&repo, &head(), path, None, options).unwrap();

    assert_eq!(
        diff("assets/logo.png", &options).content,
        DiffContent::Binary {
            old_size: Some(18.0),
            new_size: Some(20.0)
        }
    );

    // > 1 MB file with a one-line change: not rendered unless forced.
    let big = diff("big.txt", &options);
    assert!(matches!(
        big.content,
        DiffContent::TooLarge {
            old_size: Some(size),
            new_size: Some(_),
            lines: None,
        } if size > 4_000_000.0
    ));
    let forced = diff(
        "big.txt",
        &DiffOptions {
            force: true,
            ..DiffOptions::default()
        },
    );
    assert_eq!(text(forced.content).hunks.len(), 1);

    // > 5 000 rendered lines.
    assert!(matches!(
        diff("generated.json", &options).content,
        DiffContent::TooLarge {
            old_size: None,
            lines: Some(6000),
            ..
        }
    ));

    assert_eq!(
        diff("libs/sub", &options).content,
        DiffContent::Submodule {
            old_commit: Some("1111111111111111111111111111111111111111".into()),
            new_commit: Some("2222222222222222222222222222222222222222".into()),
        }
    );

    let script = diff("run.sh", &options);
    assert_eq!(script.new_mode, Some(FileMode::Executable));
    assert!(text(script.content).hunks.is_empty());
}

#[test]
fn line_endings_and_encodings_are_reported() {
    let fx = Fixture::new("diff");
    let repo = open(&fx);
    let crlf = text(
        file_diff(&repo, &head(), "crlf.txt", None, &DiffOptions::default())
            .unwrap()
            .content,
    );
    assert_eq!(crlf.old_line_ending, LineEnding::Lf);
    assert_eq!(crlf.new_line_ending, LineEnding::Crlf);
    let ignoring = text(
        file_diff(
            &repo,
            &head(),
            "crlf.txt",
            None,
            &DiffOptions {
                ignore_whitespace: true,
                ..DiffOptions::default()
            },
        )
        .unwrap()
        .content,
    );
    assert!(ignoring.hunks.is_empty());

    let latin = text(
        file_diff(&repo, &head(), "latin1.txt", None, &DiffOptions::default())
            .unwrap()
            .content,
    );
    assert_eq!(latin.new_encoding, TextEncoding::Windows1252);
    assert_eq!(latin.hunks[0].lines, ["café", "café crème"]);
}

#[test]
fn working_tree_staged_and_unstaged() {
    let fx = Fixture::new("diff");
    let repo = open(&fx);

    let staged = changed_files(&repo, &DiffTarget::Staged).unwrap();
    let paths: Vec<_> = staged.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["docs/staged.md", "src/app.ts"]);
    assert_eq!(
        find(&staged.files, "docs/staged.md").status,
        FileStatus::Added
    );
    let diff = file_diff(
        &repo,
        &DiffTarget::Staged,
        "src/app.ts",
        None,
        &DiffOptions::default(),
    )
    .unwrap();
    assert_eq!(
        text(diff.content).hunks[0].lines[..2],
        ["export const a = 2;", "export const a = 3;"]
    );

    let unstaged = changed_files(&repo, &DiffTarget::Unstaged).unwrap();
    let statuses: Vec<_> = unstaged
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.status))
        .collect();
    assert_eq!(
        statuses,
        [
            ("crlf.txt", FileStatus::Modified),
            ("docs/added.md", FileStatus::Deleted),
            ("notes.txt", FileStatus::Untracked),
        ]
    );
    assert_eq!(find(&unstaged.files, "crlf.txt").additions, Some(1));

    let worktree = file_diff(
        &repo,
        &DiffTarget::Unstaged,
        "crlf.txt",
        None,
        &DiffOptions::default(),
    )
    .unwrap();
    // The working tree side is identified like `git hash-object` (after conversion).
    let hashed = std::process::Command::new("git")
        .args(["hash-object", "crlf.txt"])
        .current_dir(fx.repo())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert_eq!(
        worktree.new_id.as_deref(),
        Some(String::from_utf8(hashed.stdout).unwrap().trim())
    );
    let text = text(worktree.content);
    assert_eq!(text.hunks[0].kinds, "   +");
    assert_eq!(text.new_line_ending, LineEnding::Crlf);

    let untracked = file_diff(
        &repo,
        &DiffTarget::Unstaged,
        "notes.txt",
        None,
        &DiffOptions::default(),
    )
    .unwrap();
    assert_eq!(untracked.old_mode, None);
    assert!(matches!(untracked.content, DiffContent::Text(t) if t.additions == 1));
}

#[test]
fn unborn_repository_staged_and_unstaged() {
    let fx = Fixture::new("unborn");
    std::fs::write(fx.repo().join("a.txt"), "a\n").unwrap();
    fx.git(&["add", "a.txt"]);
    std::fs::write(fx.repo().join("a.txt"), "a\nb\n").unwrap();
    std::fs::write(fx.repo().join("new.txt"), "new\n").unwrap();
    let repo = open(&fx);

    let staged = changed_files(&repo, &DiffTarget::Staged).unwrap();
    assert_eq!(staged.files.len(), 1);
    assert_eq!(staged.files[0].status, FileStatus::Added);
    assert_eq!(staged.files[0].additions, Some(1));
    let diff = file_diff(
        &repo,
        &DiffTarget::Staged,
        "a.txt",
        None,
        &DiffOptions::default(),
    )
    .unwrap();
    assert_eq!(diff.old_mode, None);
    assert_eq!(text(diff.content).hunks[0].kinds, "+");

    let unstaged = changed_files(&repo, &DiffTarget::Unstaged).unwrap();
    let statuses: Vec<_> = unstaged
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.status))
        .collect();
    assert_eq!(
        statuses,
        [
            ("a.txt", FileStatus::Modified),
            ("new.txt", FileStatus::Untracked)
        ]
    );
    let diff = file_diff(
        &repo,
        &DiffTarget::Unstaged,
        "a.txt",
        None,
        &DiffOptions::default(),
    )
    .unwrap();
    assert_eq!(text(diff.content).hunks[0].kinds, " +");
    let diff = file_diff(
        &repo,
        &DiffTarget::Unstaged,
        "new.txt",
        None,
        &DiffOptions::default(),
    )
    .unwrap();
    assert_eq!(text(diff.content).additions, 1);
    // Nothing is committed: commit targets report an unknown revision, not a crash.
    let err = changed_files(
        &repo,
        &DiffTarget::Commits {
            from: None,
            to: "HEAD".into(),
        },
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
}

/// A symlinked folder pointing outside the working tree must not be read through (§9).
#[cfg(unix)]
#[test]
fn never_reads_through_a_symlinked_folder() {
    let fx = Fixture::new("diff");
    let outside = fx.root.join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "top secret\n").unwrap();
    std::os::unix::fs::symlink(&outside, fx.repo().join("linkdir")).unwrap();
    let repo = open(&fx);
    let options = DiffOptions::default();

    let err = file_diff(
        &repo,
        &DiffTarget::Unstaged,
        "linkdir/secret.txt",
        None,
        &options,
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    // Ignored or unknown files are not readable either.
    std::fs::write(fx.repo().join(".git/info/exclude"), "ignored.txt\n").unwrap();
    std::fs::write(fx.repo().join("ignored.txt"), "hidden\n").unwrap();
    let err = file_diff(&repo, &DiffTarget::Unstaged, "ignored.txt", None, &options).unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);

    // The status lists the symlink itself, whose diff is its target path.
    let unstaged = changed_files(&repo, &DiffTarget::Unstaged).unwrap();
    assert!(
        unstaged
            .files
            .iter()
            .all(|f| !f.path.starts_with("linkdir/"))
    );
    let link = find(&unstaged.files, "linkdir");
    assert_eq!(link.new_mode, Some(FileMode::Symlink));
    let diff = file_diff(&repo, &DiffTarget::Unstaged, "linkdir", None, &options).unwrap();
    let target = text(diff.content);
    assert_eq!(
        target.hunks[0].lines,
        [outside.to_string_lossy().into_owned()]
    );
}

#[test]
fn rejects_bad_arguments() {
    let fx = Fixture::new("diff");
    let repo = open(&fx);
    let options = DiffOptions::default();
    for path in ["../outside.txt", "/etc/passwd", ""] {
        let err = file_diff(&repo, &DiffTarget::Unstaged, path, None, &options).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidArgument, "{path}");
    }
    let err = changed_files(
        &repo,
        &DiffTarget::Commits {
            from: None,
            to: "--output=x".into(),
        },
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    let err = changed_files(
        &repo,
        &DiffTarget::Commits {
            from: None,
            to: "no-such-branch".into(),
        },
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    let err = file_diff(&repo, &head(), "not/changed.txt", None, &options).unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
}

#[test]
fn commands_go_through_an_open_session() {
    let fx = Fixture::new("diff");
    let b = backend(false);
    let info = b.repos.open(&fx.repo_str()).unwrap();
    let repo = b
        .repos
        .session(info.id)
        .unwrap()
        .repo()
        .unwrap()
        .to_thread_local();
    assert_eq!(changed_files(&repo, &head()).unwrap().files.len(), 11);
}

/// P-06 backend share: `cargo test --release --test diff p06 -- --ignored --nocapture`.
/// A 4 800-line file with scattered changes, diffed through the whole pipeline.
#[test]
#[ignore = "measurement, run on demand in release mode"]
fn p06_backend_file_diff_time() {
    let fx = Fixture::new("unborn");
    let file = fx.repo().join("big.ts");
    let content = |tweak: bool| -> String {
        (0..4_800)
            .map(|i| {
                if tweak && i % 97 == 3 {
                    format!("export const value{i} = compute({i}, true);\n")
                } else {
                    format!("export const value{i} = compute({i});\n")
                }
            })
            .collect()
    };
    std::fs::write(&file, content(false)).unwrap();
    fx.git(&["add", "big.ts"]);
    fx.git(&["commit", "-q", "-m", "base"]);
    std::fs::write(&file, content(true)).unwrap();
    fx.git(&["commit", "-q", "-am", "change"]);
    let repo = open(&fx);
    let mut times: Vec<f64> = (0..20)
        .map(|_| {
            let start = std::time::Instant::now();
            let diff = file_diff(&repo, &head(), "big.ts", None, &DiffOptions::default()).unwrap();
            assert!(matches!(diff.content, DiffContent::Text(_)));
            start.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    times.sort_by(f64::total_cmp);
    println!(
        "P-06 backend file_diff, 4 800 lines, 50 hunks: median {:.2} ms, max {:.2} ms",
        times[times.len() / 2],
        times[times.len() - 1]
    );
}
