//! Graph, diff and branch tools (M4-7b) on the `branches` fixture: graph filter, merge-base,
//! comparison, image diff, external diff tool and branch cleanup (with undo).

mod common;

use std::sync::Arc;

use common::{Fixture, RecordingSink};
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::errors::ErrorCode;
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::read::diff::types::{DiffSide, DiffTarget};
use yaggui_lib::graph::types::GraphFilter;
use yaggui_lib::repo::RepoManager;
use yaggui_lib::store::Store;

struct Env {
    fx: Fixture,
    store: Arc<Store>,
    repos: Arc<RepoManager>,
    id: u32,
}

fn env() -> Env {
    let fx = Fixture::new("branches");
    let sink = Arc::new(RecordingSink::default());
    let git = GitCli::new(Arc::new(CommandLog::new()), sink.clone())
        .with_env("GIT_CONFIG_NOSYSTEM", "1")
        .with_env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        );
    let store = Arc::new(Store::open_in_memory().unwrap());
    let repos = Arc::new(
        RepoManager::new(Arc::new(git), Arc::clone(&store), sink)
            .without_watcher()
            .with_backup_dir(fx.root.join("backups")),
    );
    let id = repos.open(&fx.repo_str()).unwrap().id;
    Env {
        fx,
        store,
        repos,
        id,
    }
}

impl Env {
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

    /// Summaries of every graph row, top to bottom.
    fn rows(&self) -> Vec<String> {
        self.repos.graph_page(self.id, 0, 500).unwrap().summaries
    }

    /// Ref labels shown on the graph.
    fn labels(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .repos
            .graph_page(self.id, 0, 500)
            .unwrap()
            .refs
            .into_iter()
            .map(|r| r.label.name)
            .collect();
        names.sort();
        names
    }

    fn branches(&self) -> Vec<String> {
        self.out(&["branch", "--format=%(refname:short)"])
            .lines()
            .map(str::to_owned)
            .collect()
    }
}

fn hide(names: &[&str]) -> GraphFilter {
    GraphFilter {
        hidden: names.iter().map(|n| (*n).to_owned()).collect(),
        ..GraphFilter::default()
    }
}

#[test]
fn hidden_branches_leave_the_graph_and_the_filter_persists() {
    let e = env();
    assert!(e.rows().contains(&"wip 2".to_owned()));
    let stored = e
        .repos
        .set_graph_filter(
            e.id,
            hide(&["refs/heads/feat/wip", "refs/heads/gone", "refs/heads/gone"]),
        )
        .unwrap();
    assert_eq!(stored.hidden, ["refs/heads/feat/wip", "refs/heads/gone"]);
    let rows = e.rows();
    assert!(
        !rows.iter().any(|s| s.starts_with("wip") || s == "gone 1"),
        "{rows:?}"
    );
    assert_eq!(rows.first().map(String::as_str), Some("bigger logo"));
    assert!(!e.labels().contains(&"feat/wip".to_owned()));

    // Kept per repository, across sessions.
    e.repos.close(e.id);
    let again = e.repos.open(&e.fx.repo_str()).unwrap().id;
    assert_eq!(again, e.id);
    assert_eq!(e.repos.graph_filter(e.id).unwrap(), stored);
    assert_eq!(e.store.graph_filter(e.id).unwrap(), stored);
    assert!(!e.rows().contains(&"wip 2".to_owned()));

    // Show all.
    e.repos
        .set_graph_filter(e.id, GraphFilter::default())
        .unwrap();
    assert!(e.rows().contains(&"wip 2".to_owned()));
    assert_eq!(e.store.graph_filter(e.id).unwrap(), GraphFilter::default());
}

#[test]
fn solo_shows_one_branch_history_only() {
    let e = env();
    e.repos
        .set_graph_filter(
            e.id,
            GraphFilter {
                solo: Some("refs/heads/feat/wip".into()),
                ..GraphFilter::default()
            },
        )
        .unwrap();
    assert_eq!(e.rows(), ["wip 2", "wip 1", "add src", "initial commit"]);
    // Other refs on those commits keep their label.
    assert!(e.labels().contains(&"merged".to_owned()));
    assert!(e.labels().contains(&"feat/wip".to_owned()));

    // A solo branch that no longer exists shows everything again.
    e.repos
        .set_graph_filter(
            e.id,
            GraphFilter {
                solo: Some("refs/heads/no-such".into()),
                ..GraphFilter::default()
            },
        )
        .unwrap();
    assert!(e.rows().contains(&"bigger logo".to_owned()));
}

#[test]
fn remotes_and_stashes_can_be_hidden() {
    let e = env();
    assert!(e.labels().contains(&"origin/main".to_owned()));
    e.repos
        .set_graph_filter(
            e.id,
            GraphFilter {
                hide_remotes: true,
                hide_stashes: true,
                ..GraphFilter::default()
            },
        )
        .unwrap();
    assert!(!e.labels().iter().any(|l| l.starts_with("origin/")));
    // HEAD stays even when everything else is hidden.
    e.repos
        .set_graph_filter(
            e.id,
            hide(&[
                "refs/heads/main",
                "refs/heads/feat/wip",
                "refs/heads/gone",
                "refs/heads/merged",
                "refs/heads/release/1",
                "refs/heads/in-worktree",
                "refs/remotes/origin/main",
            ]),
        )
        .unwrap();
    assert_eq!(e.rows().first().map(String::as_str), Some("bigger logo"));
}

#[test]
fn a_filter_names_branches_or_tags_only() {
    let e = env();
    for bad in ["HEAD", "main", "refs/stash", "refs/heads/../x", "-x"] {
        let err = e.repos.set_graph_filter(e.id, hide(&[bad])).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidArgument, "{bad}");
    }
    assert_eq!(e.repos.graph_filter(e.id).unwrap(), GraphFilter::default());
}

#[test]
fn finds_the_merge_base_of_two_revisions() {
    let e = env();
    let base = e
        .repos
        .merge_base(e.id, "main", "feat/wip")
        .unwrap()
        .unwrap();
    assert_eq!(base.sha, e.rev("merged"));
    let rows = e.rows();
    assert_eq!(rows[base.row.unwrap() as usize], "add src");
    let same = e.repos.merge_base(e.id, "main", "main").unwrap().unwrap();
    assert_eq!(same.sha, e.rev("main"));
    assert_eq!(
        e.repos.merge_base(e.id, "main", "nope").unwrap_err().code,
        ErrorCode::RevisionNotFound
    );
}

#[test]
fn compares_two_branches_both_ways() {
    let e = env();
    // `row` is only filled for commits the incremental walk already reached (the front
    // resolves the others): load the first page so the walk covers this small fixture.
    e.rows();
    let cmp = e.repos.compare(e.id, "feat/wip", "main").unwrap();
    let summaries = |list: &[yaggui_lib::graph::types::ComparedCommit]| -> Vec<String> {
        list.iter().map(|c| c.summary.clone()).collect()
    };
    assert_eq!(summaries(&cmp.only_a), ["wip 2", "wip 1"]);
    assert_eq!(summaries(&cmp.only_b), ["bigger logo", "images", "main 3"]);
    assert_eq!((cmp.only_a_count, cmp.only_b_count), (2, 3));
    assert_eq!(cmp.merge_base.as_deref(), Some(e.rev("merged").as_str()));
    assert!(cmp.only_a.iter().all(|c| c.row.is_some()));
    assert_eq!(cmp.a, e.rev("feat/wip"));

    let same = e.repos.compare(e.id, "merged", "release/1").unwrap();
    assert!(same.only_a.is_empty() && same.only_b.is_empty());
}

#[test]
fn serves_both_sides_of_an_image_as_data_urls() {
    let e = env();
    let target = DiffTarget::Commits {
        from: None,
        to: "HEAD".into(),
    };
    let old = e
        .repos
        .diff_image(e.id, &target, "logo.png", None, DiffSide::Old)
        .unwrap()
        .unwrap();
    let new = e
        .repos
        .diff_image(e.id, &target, "logo.png", None, DiffSide::New)
        .unwrap()
        .unwrap();
    assert!(old.starts_with("data:image/png;base64,"));
    assert!(new.starts_with("data:image/png;base64,"));
    assert_ne!(old, new);

    // Added in the parent commit: no old side.
    let added = DiffTarget::Commits {
        from: None,
        to: "HEAD~1".into(),
    };
    assert_eq!(
        e.repos
            .diff_image(e.id, &added, "icon.svg", None, DiffSide::Old)
            .unwrap(),
        None
    );

    // Working tree side of an SVG, read from disk.
    let svg = e
        .repos
        .diff_image(e.id, &DiffTarget::Unstaged, "icon.svg", None, DiffSide::New)
        .unwrap()
        .unwrap();
    assert!(svg.starts_with("data:image/svg+xml;base64,"));

    // Not an image, or a path leaving the repository.
    assert_eq!(
        e.repos
            .diff_image(e.id, &target, "main.txt", None, DiffSide::New)
            .unwrap(),
        None
    );
    assert_eq!(
        e.repos
            .diff_image(e.id, &target, "../x.png", None, DiffSide::New)
            .unwrap_err()
            .code,
        ErrorCode::InvalidArgument
    );
}

#[test]
fn lists_merged_and_gone_branches_for_the_cleanup() {
    let e = env();
    let cleanup = e.repos.branch_cleanup(e.id).unwrap();
    assert_eq!(cleanup.into.as_deref(), Some("main"));
    let listed: Vec<(&str, bool, bool, u32)> = cleanup
        .branches
        .iter()
        .map(|b| (b.name.as_str(), b.merged, b.gone, b.unmerged))
        .collect();
    assert_eq!(
        listed,
        [("gone", false, true, 3), ("merged", true, false, 0)]
    );
    assert_eq!(cleanup.branches[0].upstream.as_deref(), Some("origin/gone"));
    assert_eq!(cleanup.protected, ["release/1"]);
    assert_eq!(cleanup.checked_out, ["in-worktree", "main"]);
}

#[test]
fn deletes_branches_locally_in_one_undoable_operation() {
    let e = env();
    let gone_sha = e.rev("gone");
    let result = e
        .repos
        .delete_branches(e.id, vec!["merged".into(), "gone".into()])
        .unwrap();
    assert_eq!(result.deleted.len(), 2);
    assert_eq!(result.deleted[1].full_name, "refs/heads/gone");
    assert_eq!(result.deleted[1].sha, gone_sha);
    assert_eq!(
        e.branches(),
        ["feat/wip", "in-worktree", "main", "release/1"]
    );
    // Local only: the remote keeps its branches.
    assert_eq!(
        e.rev("origin/main"),
        e.out(&["ls-remote", "origin", "main"])[..40]
    );

    let entry = e.repos.undo(e.id).unwrap();
    assert!(format!("{:?}", entry.op).contains("DeleteBranches"));
    assert_eq!(e.rev("gone"), gone_sha);
    assert_eq!(e.rev("merged"), e.rev("release/1"));
    assert_eq!(e.out(&["config", "branch.gone.remote"]), "origin");

    e.repos.redo(e.id).unwrap();
    assert!(e.rev("gone").is_empty() && e.rev("merged").is_empty());
}

#[test]
fn never_deletes_current_checked_out_or_protected_branches() {
    let e = env();
    for (name, code) in [
        ("main", ErrorCode::CurrentBranch),
        ("in-worktree", ErrorCode::BranchCheckedOut),
        ("release/1", ErrorCode::ProtectedBranchDelete),
        ("no-such", ErrorCode::RevisionNotFound),
    ] {
        let err = e
            .repos
            .delete_branches(e.id, vec!["merged".into(), name.into()])
            .unwrap_err();
        assert_eq!(err.code, code, "{name}");
    }
    // Refused batches delete nothing.
    assert!(e.branches().contains(&"merged".to_owned()));
    assert_eq!(
        e.repos.delete_branches(e.id, Vec::new()).unwrap_err().code,
        ErrorCode::InvalidArgument
    );
}

#[cfg(unix)]
#[test]
fn runs_the_configured_diff_tool() {
    let e = env();
    let out = e.fx.root.join("difftool.txt");
    // A "tool" that records what Git hands it.
    e.fx.git(&[
        "config",
        "difftool.fake.cmd",
        &format!("printf '%s\\n' \"$MERGED\" >> '{}'", out.display()),
    ]);

    // Nothing configured: refused before running anything.
    let target = DiffTarget::Commits {
        from: None,
        to: "HEAD~2".into(),
    };
    assert_eq!(
        e.repos
            .run_diff_tool(e.id, &target, "main.txt", None)
            .unwrap_err()
            .code,
        ErrorCode::DiffToolMissing
    );

    e.fx.git(&["config", "diff.tool", "fake"]);
    assert_eq!(
        e.repos
            .run_diff_tool(e.id, &target, "main.txt", None)
            .unwrap(),
        "fake"
    );
    assert_eq!(std::fs::read_to_string(&out).unwrap(), "main.txt\n");
    e.repos
        .run_diff_tool(e.id, &DiffTarget::Unstaged, "icon.svg", None)
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(&out).unwrap(),
        "main.txt\nicon.svg\n"
    );

    // The tool of the preferences wins over diff.tool.
    let mut prefs = e.store.preferences().unwrap();
    prefs.diff_tool = Some("yaggui-no-such-tool".into());
    e.store.set_preferences(&prefs).unwrap();
    assert_eq!(
        e.repos
            .run_diff_tool(e.id, &target, "main.txt", None)
            .unwrap_err()
            .code,
        ErrorCode::DiffToolFailed
    );
}
