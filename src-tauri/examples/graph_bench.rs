//! Graph benchmark (P-02, P-03). See `scripts/bench-graph.sh`.
//!
//! `graph-bench run <repo> [--first-parent] [--search <text>] [--path <path>] [--dump <file>
//! [--dump-rows <n>]]` measures a cold graph load and page requests as the frontend issues them,
//! in first-parent mode (F-032) with `--first-parent`.
//! `graph-bench gen <commits>` prints a `git fast-import` stream of a synthetic history
//! (long-lived branches, features, merges) of that many commits.

use std::io::Write;
use std::time::{Duration, Instant};

use yaggui_lib::graph::types::{CommitSearch, GRAPH_PAGE_SIZE, GraphFilter};
use yaggui_lib::graph::{self, GraphCache};

fn ms(d: Duration) -> String {
    format!("{:.1} ms", d.as_secs_f64() * 1000.0)
}

/// `dump`: file to write the SHAs of the first rows to, one per line (compare with
/// `git log --topo-order --branches --remotes --tags HEAD --format=%H`).
fn run(
    path: &str,
    first_parent: bool,
    search: Option<String>,
    search_path: Option<String>,
    dump: Option<(String, u32)>,
) {
    let started = Instant::now();
    let repo = gix::open(path).expect("open repository");
    let opened = started.elapsed();
    let cache = GraphCache::default();
    cache.set_filter(GraphFilter {
        first_parent,
        ..GraphFilter::default()
    });
    let snapshot = cache.snapshot(&repo).expect("graph");
    let built = started.elapsed();
    let first = graph::page(&repo, &snapshot, 0, GRAPH_PAGE_SIZE).expect("page 0");
    let first_screen = started.elapsed();
    let known = first.total_rows;
    // The background thread keeps walking; this waits for it (and helps).
    let total = snapshot.complete(&repo.objects).expect("whole history");
    let walked = started.elapsed();
    println!("repository        {path}");
    println!("first-parent      {first_parent}");
    println!("commits (rows)    {total}");
    println!(
        "commit-graph      {}",
        if snapshot.has_commit_graph() {
            "yes"
        } else {
            "no"
        }
    );
    println!("gix open          {}", ms(opened));
    println!("walk started      {}", ms(built - opened));
    println!("first page (500)  {}", ms(first_screen - built));
    println!("FIRST SCREEN      {}", ms(first_screen));
    println!(
        "rows known then   {known}{}",
        if first.total_exact { " (exact)" } else { "" }
    );
    println!("whole history     {}", ms(walked));
    println!("walk broken       {}", snapshot.is_broken());
    if let Some((path, rows)) = dump {
        let mut all = Vec::new();
        while (all.len() as u32) < rows.min(total) {
            let page =
                graph::page(&repo, &snapshot, all.len() as u32, GRAPH_PAGE_SIZE).expect("page");
            all.extend(page.shas);
        }
        std::fs::write(path, all.join("\n") + "\n").expect("dump");
    }

    let t = Instant::now();
    let again = cache.snapshot(&repo).expect("graph");
    println!("cached snapshot   {}", ms(t.elapsed()));
    let t = Instant::now();
    graph::page(&repo, &again, 500, GRAPH_PAGE_SIZE).expect("page 1");
    println!("next page         {}", ms(t.elapsed()));
    let middle = total / 2;
    let t = Instant::now();
    graph::page(&repo, &again, middle, GRAPH_PAGE_SIZE).expect("middle page");
    println!("jump to middle    {}", ms(t.elapsed()));
    let t = Instant::now();
    let last =
        graph::page(&repo, &again, total.saturating_sub(500), GRAPH_PAGE_SIZE).expect("last page");
    println!("jump to end       {}", ms(t.elapsed()));
    let t = Instant::now();
    graph::page(&repo, &again, middle + 1000, GRAPH_PAGE_SIZE).expect("page after middle");
    println!("page after middle {}", ms(t.elapsed()));
    let max_lanes = [first.lane_count, last.lane_count]
        .into_iter()
        .max()
        .unwrap_or(0);
    println!("lanes (first/last pages) {max_lanes}");

    let t = Instant::now();
    yaggui_lib::git::read::refs::refs_fingerprint(&repo).expect("fingerprint");
    println!("refs fingerprint  {}", ms(t.elapsed()));
    let mut counts = yaggui_lib::git::read::refs::RefsCache::default();
    let t = Instant::now();
    let refs = yaggui_lib::git::read::refs::read_refs(&repo, &mut counts).expect("refs");
    println!(
        "list refs         {} ({} local, {} tags)",
        ms(t.elapsed()),
        refs.local.len(),
        refs.tags.len()
    );
    let t = Instant::now();
    yaggui_lib::git::read::refs::read_refs(&repo, &mut counts).expect("refs");
    println!("list refs again   {}", ms(t.elapsed()));

    for (label, query) in [
        (
            "search text",
            search.map(|text| CommitSearch {
                text: Some(text),
                ..CommitSearch::default()
            }),
        ),
        (
            "search path",
            search_path.map(|p| CommitSearch {
                path: Some(p),
                ..CommitSearch::default()
            }),
        ),
    ] {
        let Some(query) = query else { continue };
        let t = Instant::now();
        let mut from = 0;
        let mut matches = 0;
        let mut chunks = 0;
        loop {
            let chunk =
                graph::search::search(&repo, &again, &query, from, graph::search::SEARCH_BUDGET)
                    .expect("search");
            chunks += 1;
            matches += chunk.matches.len();
            match chunk.next_row {
                Some(next) if t.elapsed() < Duration::from_secs(20) => from = next,
                Some(next) => {
                    println!(
                        "{label:<17} stopped after 20 s at row {next}: {:.0} rows/s",
                        f64::from(next) / t.elapsed().as_secs_f64()
                    );
                    break;
                }
                None => {
                    println!(
                        "{label:<17} {} for {total} rows, {chunks} chunks, {matches} matches",
                        ms(t.elapsed())
                    );
                    break;
                }
            }
        }
    }
}

/// Synthetic history: a main line, a long-lived `next` merged both ways, and feature branches
/// of 1 to 40 commits merged back. Commits only touch one small file.
fn generate(commits: u64) {
    let out = std::io::stdout();
    let mut out = std::io::BufWriter::new(out.lock());
    let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
    let mut rand = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let mark = std::cell::Cell::new(0u64);
    let mut time: u64 = 1_000_000_000;
    let mut emit = |out: &mut dyn Write, branch: &str, parents: &[u64], message: &str| -> u64 {
        mark.set(mark.get() + 1);
        let mark = mark.get();
        time += 30;
        writeln!(out, "commit refs/heads/{branch}").unwrap();
        writeln!(out, "mark :{mark}").unwrap();
        writeln!(out, "author Bench <bench@yaggui.dev> {time} +0000").unwrap();
        writeln!(out, "committer Bench <bench@yaggui.dev> {time} +0000").unwrap();
        writeln!(out, "data {}\n{message}", message.len()).unwrap();
        if let Some((first, rest)) = parents.split_first() {
            writeln!(out, "from :{first}").unwrap();
            for p in rest {
                writeln!(out, "merge :{p}").unwrap();
            }
        }
        let file = format!("{}\n", mark);
        writeln!(
            out,
            "M 644 inline f{}.txt\ndata {}\n{file}",
            mark % 64,
            file.len()
        )
        .unwrap();
        mark
    };
    let mut main = emit(&mut out, "main", &[], "initial");
    let mut next = emit(&mut out, "next", &[main], "start next");
    let mut features: Vec<(String, u64, u64)> = Vec::new();
    let mut serial = 0;
    while mark.get() < commits {
        let r = rand() % 100;
        if features.len() < 12 && r < 6 {
            serial += 1;
            features.push((format!("topic/{serial}"), main, 1 + rand() % 40));
        } else if r < 60 && !features.is_empty() {
            let i = (rand() as usize) % features.len();
            let (name, tip, left) = &mut features[i];
            *tip = emit(&mut out, name, &[*tip], "topic work");
            *left = left.saturating_sub(1);
            if *left == 0 {
                let tip = *tip;
                features.swap_remove(i);
                main = emit(&mut out, "main", &[main, tip], "Merge topic");
            }
        } else if r < 85 {
            main = emit(&mut out, "main", &[main], "main work");
        } else if r < 95 {
            next = emit(&mut out, "next", &[next], "next work");
        } else if r < 98 {
            next = emit(&mut out, "next", &[next, main], "Merge main into next");
        } else {
            main = emit(&mut out, "main", &[main, next], "Merge next");
        }
    }
    out.flush().unwrap();
}

/// Time to start watching a repository and number of inotify watches it costs (Linux).
fn watch(path: &str) {
    use std::sync::Arc;
    let sink: Arc<dyn yaggui_lib::events::EventSink> = Arc::new(yaggui_lib::events::NullSink);
    let git = Arc::new(yaggui_lib::git::cli::GitCli::new(
        Arc::new(yaggui_lib::git::log::CommandLog::new()),
        Arc::clone(&sink),
    ));
    let store = Arc::new(yaggui_lib::store::Store::open_in_memory().expect("store"));
    let repos = yaggui_lib::repo::RepoManager::new(git, store, sink);
    let started = Instant::now();
    let info = repos.open(path).expect("open");
    println!("open with watcher {}", ms(started.elapsed()));
    if let Some(err) = &info.watch_error {
        println!("watch error       {err}");
    }
    let watches: usize = std::fs::read_dir("/proc/self/fdinfo")
        .map(|dir| {
            dir.flatten()
                .filter_map(|e| std::fs::read_to_string(e.path()).ok())
                .map(|text| {
                    text.lines()
                        .filter(|l| l.starts_with("inotify wd:"))
                        .count()
                })
                .sum()
        })
        .unwrap_or(0);
    println!("inotify watches   {watches}");
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1).cloned())
    };
    match args.first().map(String::as_str) {
        Some("run") if args.len() >= 2 => run(
            &args[1],
            args.iter().any(|a| a == "--first-parent"),
            flag("--search"),
            flag("--path"),
            flag("--dump").map(|file| {
                let rows = flag("--dump-rows").and_then(|r| r.parse().ok());
                (file, rows.unwrap_or(u32::MAX))
            }),
        ),
        Some("watch") if args.len() >= 2 => watch(&args[1]),
        Some("gen") if args.len() >= 2 => generate(args[1].parse().expect("commit count")),
        _ => {
            eprintln!(
                "usage: graph-bench run <repo> [--first-parent] [--search <text>] [--path <path>] [--dump <file> [--dump-rows <n>]] | gen <commits>"
            );
            std::process::exit(2);
        }
    }
}
