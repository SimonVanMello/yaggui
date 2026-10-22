//! Commit graph, refs, search and commit detail on generated fixtures.

mod common;

use std::path::Path;
use std::process::Command;

use common::{Backend, Fixture, backend};
use yaggui_lib::git::errors::ErrorCode;
use yaggui_lib::git::read::state::HeadState;
use yaggui_lib::graph::types::{CommitSearch, GraphFilter, GraphPage, RefKind, edge_kind};

/// Runs git in `dir` with the fixture's isolated config and a fixed, late date.
fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_AUTHOR_NAME", "yaggui Tests")
        .env("GIT_AUTHOR_EMAIL", "tests@yaggui.dev")
        .env("GIT_COMMITTER_NAME", "yaggui Tests")
        .env("GIT_COMMITTER_EMAIL", "tests@yaggui.dev")
        .env("GIT_AUTHOR_DATE", "@1800000000 +0000")
        .env("GIT_COMMITTER_DATE", "@1800000000 +0000")
        .output()
        .expect("run git");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).expect("utf-8 output")
}

/// `git log --topo-order` over the same tips as the graph.
fn git_topo_order(dir: &Path) -> Vec<String> {
    git(
        dir,
        &[
            "log",
            "--topo-order",
            "--branches",
            "--remotes",
            "--tags",
            "HEAD",
            "--format=%H",
        ],
    )
    .lines()
    .map(str::to_owned)
    .collect()
}

fn all_rows(b: &Backend, id: u32) -> GraphPage {
    let mut all = b.repos.graph_page(id, 0, 500).unwrap();
    while (all.shas.len() as u32) < all.total_rows {
        let next = b.repos.graph_page(id, all.shas.len() as u32, 500).unwrap();
        assert_eq!(next.version, all.version);
        let base = all.edges.len() as u32 / 4;
        all.edge_offsets.pop();
        all.edge_offsets
            .extend(next.edge_offsets.iter().map(|o| o + base));
        all.shas.extend(next.shas);
        all.parents.extend(next.parents);
        all.summaries.extend(next.summaries);
        all.lanes.extend(next.lanes);
        all.colors.extend(next.colors);
        all.edges.extend(next.edges);
        all.refs.extend(next.refs);
    }
    all
}

fn row_edges(page: &GraphPage, k: usize) -> Vec<[u32; 4]> {
    let (from, to) = (
        page.edge_offsets[k] as usize,
        page.edge_offsets[k + 1] as usize,
    );
    page.edges[4 * from..4 * to].as_chunks::<4>().0.to_vec()
}

/// Structural checks every page must pass.
fn check_page(page: &GraphPage) {
    let n = page.shas.len();
    assert_eq!(page.edge_offsets.len(), n + 1);
    assert_eq!(
        *page.edge_offsets.last().unwrap() as usize,
        page.edges.len() / 4
    );
    for column in [
        page.parents.len(),
        page.summaries.len(),
        page.lanes.len(),
        page.colors.len(),
    ] {
        assert_eq!(column, n);
    }
    for k in 0..n {
        for parent in &page.parents[k] {
            if let Some(p) = page.shas.iter().position(|s| s == parent) {
                assert!(p > k, "parent above its child at row {k}");
                if p == k + 1 {
                    assert!(
                        row_edges(page, k)
                            .iter()
                            .any(|e| e[0] == page.lanes[k] && e[1] == page.lanes[k + 1]),
                        "row {k} not linked to its parent below"
                    );
                }
            }
        }
        for e in row_edges(page, k) {
            assert!(e[0] < page.lane_count.max(1) && e[1] < page.lane_count.max(1));
        }
    }
}

/// Compact text rendering of the layout, compared to a committed snapshot.
fn render(page: &GraphPage) -> String {
    let mut out = String::new();
    for k in 0..page.shas.len() {
        let refs: Vec<_> = page
            .refs
            .iter()
            .filter(|r| r.row as usize == page.start as usize + k)
            .map(|r| r.label.name.clone())
            .collect();
        let edges: Vec<_> = row_edges(page, k)
            .iter()
            .map(|e| {
                let kind = match e[3] {
                    edge_kind::MERGE => "m",
                    edge_kind::WIP => "w",
                    _ => "",
                };
                format!("{}>{}{kind}", e[0], e[1])
            })
            .collect();
        out.push_str(&format!(
            "{:>2} lane {} {:<16} [{}] {}\n",
            k,
            page.lanes[k],
            page.summaries[k],
            edges.join(" "),
            refs.join(", ")
        ));
    }
    out
}

fn assert_snapshot(name: &str, actual: &str) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/snapshots")
        .join(name);
    if std::env::var_os("UPDATE_SNAPSHOTS").is_some() || !path.exists() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, actual).unwrap();
    }
    let expected = std::fs::read_to_string(&path)
        .unwrap()
        .replace("\r\n", "\n");
    assert_eq!(actual, expected, "layout differs from {}", path.display());
}

#[test]
fn order_matches_git_with_and_without_commit_graph() {
    for scenario in ["history", "history-detached"] {
        let fx = Fixture::new(scenario);
        let b = backend(false);
        let id = b.repos.open(&fx.repo_str()).unwrap().id;
        let page = all_rows(&b, id);
        assert_eq!(
            page.shas,
            git_topo_order(&fx.repo()),
            "{scenario} without commit-graph"
        );
        check_page(&page);
        b.repos.close(id);

        git(&fx.repo(), &["commit-graph", "write", "--reachable"]);
        assert!(fx.repo().join(".git/objects/info/commit-graph").exists());
        let b = backend(false);
        let id = b.repos.open(&fx.repo_str()).unwrap().id;
        assert_eq!(
            all_rows(&b, id).shas,
            git_topo_order(&fx.repo()),
            "{scenario} with commit-graph"
        );

        // Commits newer than the commit-graph file are read from the objects.
        git(
            &fx.repo(),
            &["commit", "-q", "--allow-empty", "-m", "after graph"],
        );
        let page = all_rows(&b, id);
        assert_eq!(
            page.shas,
            git_topo_order(&fx.repo()),
            "{scenario} with a partial commit-graph"
        );
        assert_eq!(page.summaries[0], "after graph");
    }
}

#[test]
fn layout_snapshot() {
    let fx = Fixture::new("history");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let page = b.repos.graph_page(id, 0, 500).unwrap();
    check_page(&page);
    assert_eq!(
        page.wip.as_ref().map(|w| (w.lane, w.head_row)),
        Some((0, 0))
    );
    assert!(page.parents.iter().any(|p| p.len() == 4), "octopus merge");
    assert_snapshot("history.txt", &render(&page));

    // Pages of any size give the same layout as the whole graph.
    let mut pieced = String::new();
    let mut start = 0;
    while start < page.total_rows {
        let part = b.repos.graph_page(id, start, 3).unwrap();
        check_page(&part);
        assert_eq!(part.lanes, page.lanes[start as usize..][..part.lanes.len()]);
        for k in 0..part.shas.len() {
            assert_eq!(row_edges(&part, k), row_edges(&page, start as usize + k));
        }
        pieced.push_str(&part.summaries.join("\n"));
        start += 3;
    }
    assert!(!pieced.is_empty());
}

#[test]
fn detached_head_gets_a_label_and_the_wip_lane() {
    let fx = Fixture::new("history-detached");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let page = b.repos.graph_page(id, 0, 500).unwrap();
    let head = git(&fx.repo(), &["rev-parse", "HEAD"]).trim().to_owned();
    let wip = page.wip.clone().expect("wip anchor");
    assert_eq!(page.shas[wip.head_row as usize], head);
    assert_eq!(page.lanes[wip.head_row as usize], wip.lane);
    assert!(
        page.refs
            .iter()
            .any(|r| r.label.kind == RefKind::Head && r.row == wip.head_row)
    );
    // The WIP line runs down to HEAD, and only there.
    for k in 0..wip.head_row as usize {
        assert!(row_edges(&page, k).iter().any(|e| e[3] == edge_kind::WIP));
    }
    assert!(
        row_edges(&page, wip.head_row as usize)
            .iter()
            .all(|e| e[3] != edge_kind::WIP)
    );
}

#[test]
fn unborn_repository_has_an_empty_graph() {
    let fx = Fixture::new("unborn");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let page = b.repos.graph_page(id, 0, 500).unwrap();
    assert_eq!(page.total_rows, 0);
    assert!(page.shas.is_empty() && page.wip.is_none());
    assert_eq!(page.edge_offsets, vec![0]);
    let err = b.repos.graph_index_of(id, "HEAD").unwrap_err();
    assert_eq!(err.code, ErrorCode::RevisionNotFound);
    let refs = b.repos.list_refs(id).unwrap();
    assert!(refs.local.is_empty());
    assert!(matches!(refs.head, HeadState::Unborn { .. }));
}

#[test]
fn version_changes_with_refs_only() {
    let fx = Fixture::new("history");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let first = b.repos.graph_page(id, 0, 10).unwrap();
    assert_eq!(
        b.repos.graph_page(id, 0, 10).unwrap().version,
        first.version
    );
    // Dirtying the worktree does not move rows.
    std::fs::write(fx.repo().join("new.txt"), "x").unwrap();
    assert_eq!(
        b.repos.graph_page(id, 0, 10).unwrap().version,
        first.version
    );
    git(&fx.repo(), &["branch", "extra", "main~1"]);
    let after = b.repos.graph_page(id, 0, 10).unwrap();
    assert_ne!(after.version, first.version);
    // Dropping a stash rewrites the reflog only.
    git(&fx.repo(), &["stash", "drop", "-q"]);
    assert_ne!(
        b.repos.graph_page(id, 0, 10).unwrap().version,
        after.version
    );
}

#[test]
fn stash_labels_carry_their_message() {
    let fx = Fixture::new("history");
    std::fs::write(fx.repo().join("named.txt"), "x").unwrap();
    git(
        &fx.repo(),
        &[
            "stash",
            "push",
            "-q",
            "--include-untracked",
            "-m",
            "my changes",
        ],
    );
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let page = all_rows(&b, id);
    let stash = |name: &str| {
        page.refs
            .iter()
            .find(|r| r.label.kind == RefKind::Stash && r.label.name == name)
            .map(|r| r.label.message.clone())
    };
    let named = stash("stash@{0}").flatten().unwrap_or_default();
    assert!(named.ends_with(": my changes"), "{named}");
    let older = stash("stash@{1}").flatten().unwrap_or_default();
    assert!(older.starts_with("WIP on "), "{older}");
    assert!(
        page.refs
            .iter()
            .filter(|r| r.label.kind != RefKind::Stash)
            .all(|r| r.label.message.is_none())
    );
}

#[test]
fn index_of_resolves_revisions() {
    let fx = Fixture::new("history");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let page = b.repos.graph_page(id, 0, 500).unwrap();
    for rev in ["HEAD", "main~1", "v0.2", "v0.1", "feat/b", "origin/feat/b"] {
        let sha = git(&fx.repo(), &["rev-parse", &format!("{rev}^{{commit}}")]);
        let location = b.repos.graph_index_of(id, rev).unwrap();
        assert_eq!(location.sha, sha.trim(), "{rev}");
        assert_eq!(location.version, page.version);
        assert_eq!(
            page.shas[location.row.unwrap() as usize],
            location.sha,
            "{rev}"
        );
    }
    let short = &page.shas[5][..8];
    assert_eq!(b.repos.graph_index_of(id, short).unwrap().row, Some(5));
    // The stash commit exists but is not a row.
    let stash = b.repos.graph_index_of(id, "stash@{0}").unwrap();
    assert_eq!(stash.row, None);
    for bad in ["nope", "", "--all"] {
        assert_eq!(
            b.repos.graph_index_of(id, bad).unwrap_err().code,
            ErrorCode::RevisionNotFound
        );
    }
}

#[test]
fn lists_refs_with_rows() {
    let fx = Fixture::new("history");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    // Before the graph is computed, rows are unknown.
    let early = b.repos.list_refs(id).unwrap();
    assert_eq!(early.graph_version, None);
    assert!(early.local.iter().all(|l| l.row.is_none()));

    let page = b.repos.graph_page(id, 0, 500).unwrap();
    let refs = b.repos.list_refs(id).unwrap();
    assert_eq!(refs.graph_version, Some(page.version));
    let names: Vec<_> = refs.local.iter().map(|l| l.name.as_str()).collect();
    assert_eq!(names, ["feat/a", "feat/b", "main", "pages", "x", "y"]);
    let main = refs.local.iter().find(|l| l.name == "main").unwrap();
    assert!(main.is_head);
    let upstream = main.upstream.as_ref().unwrap();
    assert_eq!(
        (upstream.name.as_str(), upstream.ahead, upstream.behind),
        ("origin/main", 1, 0)
    );
    for branch in &refs.local {
        assert_eq!(
            page.shas[branch.row.unwrap() as usize],
            branch.sha,
            "{}",
            branch.name
        );
    }

    assert_eq!(refs.remotes.len(), 1);
    assert_eq!(refs.remotes[0].name, "origin");
    assert!(
        refs.remotes[0]
            .url
            .as_deref()
            .unwrap()
            .ends_with("origin.git")
    );
    let remote: Vec<_> = refs.remotes[0]
        .branches
        .iter()
        .map(|r| r.name.as_str())
        .collect();
    assert_eq!(remote, ["origin/feat/b", "origin/main"]);

    let tags: Vec<_> = refs
        .tags
        .iter()
        .map(|t| (t.name.as_str(), t.annotated, t.message.as_deref()))
        .collect();
    assert_eq!(
        tags,
        [("v0.1", false, None), ("v0.2", true, Some("Release 0.2"))]
    );
    let v02 = &refs.tags[1];
    assert_eq!(
        page.shas[v02.row.unwrap() as usize],
        v02.sha,
        "annotated tag peeled"
    );

    assert_eq!(refs.stashes.len(), 1);
    let stash = &refs.stashes[0];
    assert!(stash.message.starts_with("WIP on main"));
    assert_eq!(page.shas[stash.row.unwrap() as usize], stash.base_sha);
    assert!(
        page.refs
            .iter()
            .any(|r| r.label.kind == RefKind::Stash && r.label.name == "stash@{0}")
    );

    assert_eq!(refs.worktrees.len(), 1);
    assert!(refs.worktrees[0].is_main && refs.worktrees[0].is_current);
    assert!(refs.submodules.is_empty());
}

#[test]
fn lists_linked_worktrees() {
    let fx = Fixture::new("worktree");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let refs = b.repos.list_refs(id).unwrap();
    assert_eq!(refs.worktrees.len(), 2);
    assert!(refs.worktrees[0].is_main && refs.worktrees[0].is_current);
    let linked = &refs.worktrees[1];
    assert!(!linked.is_main && !linked.is_current && !linked.prunable);
    assert!(matches!(&linked.head, Some(HeadState::Branch { name, .. }) if name == "wt"));
}

fn search(b: &Backend, id: u32, query: CommitSearch) -> Vec<String> {
    let page = b.repos.graph_page(id, 0, 500).unwrap();
    let mut rows = Vec::new();
    let mut from = 0;
    loop {
        let chunk = b.repos.search_commits(id, &query, from).unwrap();
        assert_eq!(chunk.version, page.version);
        rows.extend(chunk.matches);
        match chunk.next_row {
            Some(next) => from = next,
            None => break,
        }
    }
    rows.iter()
        .map(|&r| page.summaries[r as usize].clone())
        .collect()
}

#[test]
fn searches_commits() {
    let fx = Fixture::new("history");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let text = |t: &str| CommitSearch {
        text: Some(t.into()),
        ..CommitSearch::default()
    };
    assert_eq!(
        search(&b, id, text("OCTO")),
        ["Octopus", "octo 3", "octo 2", "octo 1"]
    );
    assert_eq!(search(&b, id, text("pages 1")), ["pages 1"]);
    let sha = git(&fx.repo(), &["rev-parse", "feat/b"]);
    assert_eq!(search(&b, id, text(&sha[..7])), ["b 1"]);
    assert_eq!(search(&b, id, text("tests@yaggui")).len(), 18);
    let by_path = |p: &str| CommitSearch {
        path: Some(p.into()),
        ..CommitSearch::default()
    };
    // Compared to the first parent: the merge that brought the file into main matches too.
    assert_eq!(
        search(&b, id, by_path("b.txt")),
        ["Merge feat/a", "a 2", "a 1"]
    );
    assert_eq!(
        search(&b, id, by_path("/index.html")),
        ["pages 2", "pages 1"]
    );
    // File and folder names match regardless of case, like the other fields.
    assert_eq!(
        search(&b, id, by_path("B.TXT")),
        ["Merge feat/a", "a 2", "a 1"]
    );
    assert_eq!(
        search(&b, id, by_path("/Index.HTML")),
        ["pages 2", "pages 1"]
    );
    // Dates: the first three commits (one minute apart from the base date).
    let early = CommitSearch {
        until: Some(1_767_268_800.0 + 180.0),
        ..CommitSearch::default()
    };
    assert_eq!(search(&b, id, early), ["a 1", "main 2", "initial"]);
    let combined = CommitSearch {
        text: Some("octo".into()),
        author: Some("nobody".into()),
        ..CommitSearch::default()
    };
    assert!(search(&b, id, combined).is_empty());
    assert!(search(&b, id, CommitSearch::default()).is_empty());
}

#[test]
fn search_resumes_after_its_budget() {
    let fx = Fixture::new("history");
    let repo = gix::open(fx.repo()).unwrap();
    let cache = yaggui_lib::graph::GraphCache::default();
    let snapshot = cache.snapshot(&repo).unwrap();
    let query = CommitSearch {
        text: Some("o".into()),
        ..CommitSearch::default()
    };
    let chunk =
        yaggui_lib::graph::search::search(&repo, &snapshot, &query, 0, std::time::Duration::ZERO)
            .unwrap();
    assert!(chunk.matches.is_empty());
    assert_eq!(chunk.next_row, Some(0));
}

#[test]
fn describes_a_commit() {
    let fx = Fixture::new("history");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let sha = git(&fx.repo(), &["rev-parse", "main~1"]).trim().to_owned();
    // The row is known once the history walk reached the commit (the first page here).
    b.repos.graph_page(id, 0, 500).unwrap();
    let detail = b.repos.commit_detail(id, &sha).unwrap();
    assert_eq!(detail.summary, "Octopus");
    assert_eq!(detail.parents.len(), 4);
    assert_eq!(detail.author.name, "yaggui Tests");
    assert_eq!(detail.author.offset_minutes, 0);
    assert!(detail.signature.is_none());
    let mut refs: Vec<_> = detail.refs.iter().map(|r| r.name.as_str()).collect();
    refs.sort_unstable();
    assert_eq!(refs, ["origin/main", "v0.2"]);
    assert!(detail.row.is_some());

    git(
        &fx.repo(),
        &[
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "Subject line",
            "-m",
            "Body paragraph.",
        ],
    );
    let head = git(&fx.repo(), &["rev-parse", "HEAD"]).trim().to_owned();
    let detail = b.repos.commit_detail(id, &head).unwrap();
    assert_eq!(detail.message, "Subject line\n\nBody paragraph.");
    assert!(detail.refs.iter().any(|r| r.name == "main" && r.is_head));

    let err = b.repos.commit_detail(id, "0123456789").unwrap_err();
    assert_eq!(err.code, ErrorCode::RevisionNotFound);
}

#[test]
fn path_search_works_on_a_shallow_clone() {
    let fx = Fixture::new("history");
    let shallow = fx.root.join("shallow");
    let source = format!("file://{}", fx.repo().display());
    git(
        &fx.root,
        &[
            "clone",
            "-q",
            "--depth",
            "1",
            "--no-single-branch",
            &source,
            shallow.to_str().unwrap(),
        ],
    );
    let b = backend(false);
    let id = b.repos.open(shallow.to_str().unwrap()).unwrap().id;
    let page = b.repos.graph_page(id, 0, 500).unwrap();
    assert_eq!(page.shas, git_topo_order(&shallow));
    // The oldest commits have parents cut off by the clone: they count as root commits.
    let found = search(
        &b,
        id,
        CommitSearch {
            path: Some("a.txt".into()),
            ..CommitSearch::default()
        },
    );
    assert!(!found.is_empty());

    // Without `.git/shallow` the cut parents are just missing objects: still no error.
    std::fs::remove_file(shallow.join(".git/shallow")).unwrap();
    let found = search(
        &b,
        id,
        CommitSearch {
            path: Some("a.txt".into()),
            ..CommitSearch::default()
        },
    );
    assert!(!found.is_empty());
}

#[test]
fn rebuilds_while_an_old_snapshot_is_held() {
    let fx = Fixture::new("history");
    let repo = gix::open(fx.repo()).unwrap();
    let cache = yaggui_lib::graph::GraphCache::default();
    let old = cache.snapshot(&repo).unwrap();
    let fingerprint_old = old.version;
    git(
        &fx.repo(),
        &["commit", "-q", "--allow-empty", "-m", "newer"],
    );
    let repo = gix::open(fx.repo()).unwrap();
    // `old` still holds the commit store: the rebuild copies it instead of failing.
    let new = cache.snapshot(&repo).unwrap();
    assert_ne!(new.version, fingerprint_old);
    let old_total = old.complete(&repo.objects).unwrap();
    assert_eq!(new.complete(&repo.objects).unwrap(), old_total + 1);
    let page = yaggui_lib::graph::page(&repo, &new, 0, 500).unwrap();
    assert_eq!(page.shas, git_topo_order(&fx.repo()));
    // The old snapshot keeps answering for its own version.
    assert_eq!(
        yaggui_lib::graph::page(&repo, &old, 0, 500)
            .unwrap()
            .shas
            .len() as u32,
        old_total
    );
}

/// Ahead/behind from generation numbers equals `git rev-list --left-right --count` for every
/// pair of refs, with a full commit-graph, then with commits outside it.
#[test]
fn ahead_behind_matches_git() {
    use yaggui_lib::git::read::ahead_behind::Counter;

    let fx = Fixture::new("history");
    let dir = fx.repo();
    git(&dir, &["commit-graph", "write", "--reachable"]);
    let check = |label: &str| {
        // Commits only: annotated tags peeled.
        let format = "--format=%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)";
        let refs: Vec<String> = git(&dir, &["for-each-ref", format])
            .lines()
            .map(str::to_owned)
            .collect();
        let repo = gix::open(&dir).unwrap();
        let mut counter = Counter::new(&repo).expect("commit-graph");
        let mut pairs = 0;
        for a in &refs {
            for b in &refs {
                let expected = git(
                    &dir,
                    &["rev-list", "--left-right", "--count", &format!("{a}...{b}")],
                );
                let mut counts = expected
                    .split_whitespace()
                    .map(|n| n.parse::<u32>().unwrap());
                let expected = (counts.next().unwrap(), counts.next().unwrap());
                let id = |hex: &str| gix::ObjectId::from_hex(hex.as_bytes()).unwrap();
                assert_eq!(
                    counter.count(id(a), id(b)),
                    Some(expected),
                    "{label}: {a} vs {b}"
                );
                pairs += 1;
            }
        }
        assert!(pairs > 25, "{label}: only {pairs} pairs");
    };
    check("full commit-graph");

    // Commits newer than the file: their generation is derived from their parents.
    git(&dir, &["checkout", "-q", "-b", "after-graph"]);
    for n in 0..3 {
        git(
            &dir,
            &["commit", "-q", "--allow-empty", "-m", &format!("after {n}")],
        );
    }
    git(
        &dir,
        &["merge", "-q", "--no-ff", "-m", "merge after", "main"],
    );
    check("partial commit-graph");
}

/// With a watcher, the refs fingerprint is cached until it reports a refs change.
#[test]
fn watched_sessions_see_ref_updates() {
    let fx = Fixture::new("history");
    let b = backend(true);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let before = b.repos.graph_page(id, 0, 500).unwrap();
    assert_eq!(
        b.repos.graph_page(id, 0, 500).unwrap().version,
        before.version
    );

    b.sink.clear();
    git(
        &fx.repo(),
        &["commit", "-q", "--allow-empty", "-m", "new tip"],
    );
    assert!(
        b.sink
            .wait_for(std::time::Duration::from_secs(5), |e| matches!(
                e,
                yaggui_lib::events::BackendEvent::RefsChanged(_)
            ))
    );
    let after = b.repos.graph_page(id, 0, 500).unwrap();
    assert_ne!(after.version, before.version);
    assert_eq!(after.summaries[0], "new tip");
}

// --- First-parent mode (F-032) --------------------------------------------------------------

fn first_parent() -> GraphFilter {
    GraphFilter {
        first_parent: true,
        ..GraphFilter::default()
    }
}

/// `git log --topo-order --first-parent` over the same tips as the graph. Git follows first
/// parents only in its incremental walk, the one it takes with a commit-graph: without one it
/// sorts the commits listed by every edge between them, which merges with a listed second
/// parent can reorder. The first-parent graph is that first walk, with or without the file.
fn git_first_parent_order(dir: &Path) -> Vec<String> {
    let graph = dir.join(".git/objects/info/commit-graph");
    assert!(graph.exists(), "the oracle needs a commit-graph");
    git(
        dir,
        &[
            "-c",
            "core.commitGraph=true",
            "log",
            "--topo-order",
            "--first-parent",
            "--branches",
            "--remotes",
            "--tags",
            "HEAD",
            "--format=%H",
        ],
    )
    .lines()
    .map(str::to_owned)
    .collect()
}

/// `check_page` for a first-parent graph: rows are linked to their first parent only.
fn check_first_parent_page(page: &GraphPage) {
    let mut cut = page.clone();
    for parents in &mut cut.parents {
        parents.truncate(1);
    }
    check_page(&cut);
    assert!(
        page.edges.chunks(4).all(|e| e[3] != edge_kind::MERGE),
        "no line to a merge's other parents"
    );
}

#[test]
fn first_parent_order_matches_git_with_and_without_commit_graph() {
    for scenario in ["history", "history-detached"] {
        let fx = Fixture::new(scenario);
        let b = backend(false);
        let id = b.repos.open(&fx.repo_str()).unwrap().id;
        let full = all_rows(&b, id);
        b.repos.set_graph_filter(id, first_parent()).unwrap();
        let without_graph = all_rows(&b, id);
        assert_ne!(without_graph.version, full.version);
        check_first_parent_page(&without_graph);
        b.repos.close(id);

        git(&fx.repo(), &["commit-graph", "write", "--reachable"]);
        let expected = git_first_parent_order(&fx.repo());
        assert_eq!(
            without_graph.shas, expected,
            "{scenario} without commit-graph"
        );
        assert!(expected.len() < full.shas.len());

        // The mode is kept per repository: reopening finds it.
        let id = b.repos.open(&fx.repo_str()).unwrap().id;
        assert!(b.repos.graph_filter(id).unwrap().first_parent);
        let with_graph = all_rows(&b, id);
        assert_eq!(with_graph.shas, expected, "{scenario} with commit-graph");
        check_first_parent_page(&with_graph);

        git(
            &fx.repo(),
            &["commit", "-q", "--allow-empty", "-m", "after graph"],
        );
        let partial = all_rows(&b, id);
        assert_eq!(
            partial.shas,
            git_first_parent_order(&fx.repo()),
            "{scenario} with a partial commit-graph"
        );
        assert_eq!(partial.summaries[0], "after graph");

        // Leaving the mode gives the whole graph back.
        b.repos
            .set_graph_filter(id, GraphFilter::default())
            .unwrap();
        assert_eq!(all_rows(&b, id).shas, git_topo_order(&fx.repo()));
    }
}

#[test]
fn first_parent_layout_snapshot_and_pages() {
    let fx = Fixture::new("history");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    b.repos.set_graph_filter(id, first_parent()).unwrap();
    let page = b.repos.graph_page(id, 0, 500).unwrap();
    check_first_parent_page(&page);
    // HEAD is a tip: the WIP line still ends on it.
    assert_eq!(
        page.wip.as_ref().map(|w| (w.lane, w.head_row)),
        Some((0, 0))
    );
    // Merges stay rows and keep every parent.
    assert!(page.parents.iter().any(|p| p.len() == 4), "octopus merge");
    assert_snapshot("history-first-parent.txt", &render(&page));

    // Pages of any size join up into the same layout.
    let mut start = 0;
    while start < page.total_rows {
        let part = b.repos.graph_page(id, start, 3).unwrap();
        assert_eq!(part.version, page.version);
        check_first_parent_page(&part);
        assert_eq!(part.lanes, page.lanes[start as usize..][..part.lanes.len()]);
        for k in 0..part.shas.len() {
            assert_eq!(row_edges(&part, k), row_edges(&page, start as usize + k));
        }
        start += 3;
    }
}

#[test]
fn first_parent_search_and_jumps_stay_in_the_mode() {
    let fx = Fixture::new("history");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let octo = |b: &Backend| {
        search(
            b,
            id,
            CommitSearch {
                text: Some("octo".into()),
                ..CommitSearch::default()
            },
        )
    };
    assert_eq!(octo(&b), ["Octopus", "octo 3", "octo 2", "octo 1"]);
    let octo_1 = git(&fx.repo(), &["rev-parse", "main~1^2"])
        .trim()
        .to_owned();
    assert!(b.repos.graph_index_of(id, &octo_1).unwrap().row.is_some());

    b.repos.set_graph_filter(id, first_parent()).unwrap();
    // The octopus branches were deleted: their commits are only reachable through the merge.
    assert_eq!(octo(&b), ["Octopus"]);
    let location = b.repos.graph_index_of(id, &octo_1).unwrap();
    assert_eq!(location.row, None);
    assert_eq!(location.sha, octo_1);
    // Branch tips and HEAD are always rows.
    for rev in ["HEAD", "feat/a", "feat/b", "x", "y", "pages", "v0.1"] {
        assert!(
            b.repos.graph_index_of(id, rev).unwrap().row.is_some(),
            "{rev}"
        );
    }
    // The merge-base of two branches is on the first-parent line of the older one here.
    let base = b.repos.merge_base(id, "feat/a", "feat/b").unwrap().unwrap();
    assert!(base.row.is_some());
}
