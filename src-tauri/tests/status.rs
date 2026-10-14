//! Status freshness (gix index snapshot) and P-05: status refresh after a disk change, on
//! a 50k-file worktree:
//! `cargo test --release --test status p05 -- --ignored --nocapture`
//! (`YAGGUI_BENCH_REPO=<worktree>` benches an existing repository instead of the fixture: its
//! first tracked file is edited then restored, `yaggui-p05.txt` created then removed.)

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{Fixture, backend};
use yaggui_lib::events::{BackendEvent, EventSink};
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::read::diff::{self, types::DiffTarget};
use yaggui_lib::repo::RepoManager;
use yaggui_lib::store::Store;

/// Records when each `status-changed` arrives.
#[derive(Default)]
struct TimedSink {
    status: Mutex<Vec<Instant>>,
}

impl EventSink for TimedSink {
    fn emit(&self, event: BackendEvent) {
        if matches!(event, BackendEvent::StatusChanged(_)) {
            self.status.lock().unwrap().push(Instant::now());
        }
    }
}

impl TimedSink {
    fn clear(&self) {
        self.status.lock().unwrap().clear();
    }

    /// First event after `since`, polled every millisecond.
    fn wait(&self, since: Instant) -> Option<Instant> {
        let deadline = since + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Some(at) = self.status.lock().unwrap().iter().find(|t| **t >= since) {
                return Some(*at);
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        None
    }
}

/// What the front refetches on `status-changed`, in parallel like its queries: the repo
/// state (dirty counts) and the unstaged and staged file lists.
fn refetch(repos: &Arc<RepoManager>, id: u32) -> [Duration; 3] {
    let started = Instant::now();
    let jobs: Vec<_> = (0..3)
        .map(|n| {
            let repos = Arc::clone(repos);
            std::thread::spawn(move || {
                let session = repos.session(id).unwrap();
                match n {
                    0 => drop(session.state().unwrap()),
                    1 => drop(repos.changed_files(id, &DiffTarget::Unstaged).unwrap()),
                    _ => drop(repos.changed_files(id, &DiffTarget::Staged).unwrap()),
                }
                started.elapsed()
            })
        })
        .collect();
    let mut out = [Duration::ZERO; 3];
    for (slot, job) in out.iter_mut().zip(jobs) {
        *slot = job.join().unwrap();
    }
    out
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

fn max(values: &[f64]) -> f64 {
    values.iter().copied().fold(0.0, f64::max)
}

#[test]
#[ignore = "benchmark: cargo test --release --test status p05 -- --ignored --nocapture"]
fn p05_status_refresh() {
    let fixture;
    let worktree: PathBuf = match std::env::var_os("YAGGUI_BENCH_REPO") {
        Some(path) => PathBuf::from(path),
        None => {
            fixture = Fixture::new("wide");
            fixture.repo()
        }
    };
    let sink = Arc::new(TimedSink::default());
    let git = Arc::new(GitCli::new(Arc::new(CommandLog::new()), sink.clone()));
    let store = Arc::new(Store::open_in_memory().unwrap());
    let repos = Arc::new(RepoManager::new(git, store, sink.clone()));
    let opened = Instant::now();
    let id = repos.open(&worktree.to_string_lossy()).unwrap().id;
    println!("open (watcher included): {:.0} ms", ms(opened.elapsed()));
    // Warm caches (first status writes nothing, but reads every stat once).
    refetch(&repos, id);
    std::thread::sleep(Duration::from_millis(500));

    let tracked = first_tracked_file(&worktree);
    let original = std::fs::read(&tracked).unwrap();
    let untracked = worktree.join("yaggui-p05.txt");
    let mut events = Vec::new();
    let mut totals = Vec::new();
    let mut parts: [Vec<f64>; 3] = Default::default();
    for round in 0..12 {
        sink.clear();
        let edit = Instant::now();
        // Alternates a tracked edit and an untracked file, the two common cases.
        if round % 2 == 0 {
            std::fs::write(&tracked, format!("edit {round}\n")).unwrap();
        } else if untracked.exists() {
            std::fs::remove_file(&untracked).unwrap();
        } else {
            std::fs::write(&untracked, "new\n").unwrap();
        }
        let event = sink.wait(edit).expect("status-changed");
        let fetched = refetch(&repos, id);
        let total = event.duration_since(edit) + fetched.iter().copied().max().unwrap();
        if round >= 2 {
            events.push(ms(event.duration_since(edit)));
            totals.push(ms(total));
            for (part, value) in parts.iter_mut().zip(fetched) {
                part.push(ms(value));
            }
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    // Each read alone, for the breakdown.
    std::fs::write(&tracked, "edit serial\n").unwrap();
    std::thread::sleep(Duration::from_millis(100));
    let session = repos.session(id).unwrap();
    let serial: Vec<f64> = (0..3)
        .map(|n| {
            let repo = session.repo().unwrap().to_thread_local();
            let started = Instant::now();
            match n {
                0 => drop(diff::WorktreeStatus::read(&repo).unwrap()),
                1 => drop(diff::changed_files(&repo, &DiffTarget::Unstaged).unwrap()),
                _ => drop(diff::changed_files(&repo, &DiffTarget::Staged).unwrap()),
            }
            ms(started.elapsed())
        })
        .collect();
    let _ = std::fs::remove_file(&untracked);
    std::fs::write(&tracked, original).unwrap();
    let [state, unstaged, staged] = parts;
    println!(
        "P-05 on {} ({} tracked files), {} rounds:",
        worktree.display(),
        tracked_count(&worktree),
        totals.len()
    );
    println!(
        "  disk change → status-changed: median {:.0} ms, max {:.0} ms",
        median(events.clone()),
        max(&events)
    );
    println!(
        "  repo state: median {:.0} ms · unstaged files: {:.0} ms · staged files: {:.0} ms (in parallel)",
        median(state),
        median(unstaged),
        median(staged)
    );
    println!(
        "  alone: shared status {:.0} ms · unstaged files {:.0} ms · staged files {:.0} ms",
        serial[0], serial[1], serial[2]
    );
    println!(
        "  total (front IPC and render excluded): median {:.0} ms, max {:.0} ms",
        median(totals.clone()),
        max(&totals)
    );
}

fn first_tracked_file(worktree: &Path) -> PathBuf {
    let out = std::process::Command::new("git")
        .args(["ls-files", "-z"])
        .current_dir(worktree)
        .output()
        .unwrap();
    let first = out
        .stdout
        .split(|b| *b == 0)
        .find(|p| !p.is_empty() && !p.starts_with(b".git"))
        .unwrap();
    worktree.join(String::from_utf8_lossy(first).as_ref())
}

fn tracked_count(worktree: &Path) -> usize {
    let out = std::process::Command::new("git")
        .args(["ls-files", "-z"])
        .current_dir(worktree)
        .output()
        .unwrap();
    out.stdout
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .count()
}

fn staged_paths(repos: &RepoManager, id: u32) -> Vec<String> {
    let repo = repos.session(id).unwrap().repo().unwrap().to_thread_local();
    diff::changed_paths(&repo, &DiffTarget::Staged)
        .unwrap()
        .into_iter()
        .map(|c| c.path)
        .collect()
}

#[test]
fn an_unchanged_index_is_not_read_again() {
    let fx = Fixture::new("clean");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let session = b.repos.session(id).unwrap();
    let first = session
        .repo()
        .unwrap()
        .to_thread_local()
        .index_or_empty()
        .unwrap();
    let again = session
        .repo()
        .unwrap()
        .to_thread_local()
        .index_or_empty()
        .unwrap();
    // The same shared snapshot: nothing was parsed again.
    assert!(std::ptr::eq(&**first, &**again));

    std::fs::write(fx.repo().join("new.txt"), "new\n").unwrap();
    fx.git(&["add", "new.txt"]);
    let after = session
        .repo()
        .unwrap()
        .to_thread_local()
        .index_or_empty()
        .unwrap();
    assert!(!std::ptr::eq(&**first, &**after));
    assert!(after.entry_by_path("new.txt".into()).is_some());
    assert_eq!(staged_paths(&b.repos, id), ["new.txt"]);
}

/// gix only reloads its index snapshot on a newer mtime. With coarse timestamps, a rewrite
/// can keep the same mtime: the session notices it from the size, inode and ctime.
#[cfg(unix)]
#[test]
fn an_index_rewritten_with_the_same_mtime_is_reloaded() {
    let fx = Fixture::new("clean");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    assert!(staged_paths(&b.repos, id).is_empty());
    let index = fx.repo().join(".git/index");
    let mtime = std::fs::metadata(&index).unwrap().modified().unwrap();

    std::fs::write(fx.repo().join("new.txt"), "new\n").unwrap();
    fx.git(&["add", "new.txt"]);
    let since_epoch = mtime.duration_since(std::time::UNIX_EPOCH).unwrap();
    let stamp = format!(
        "@{}.{:09}",
        since_epoch.as_secs(),
        since_epoch.subsec_nanos()
    );
    let touched = std::process::Command::new("touch")
        .args(["-m", "-d", &stamp])
        .arg(&index)
        .status()
        .unwrap();
    assert!(touched.success());
    assert_eq!(
        std::fs::metadata(&index).unwrap().modified().unwrap(),
        mtime
    );

    assert_eq!(staged_paths(&b.repos, id), ["new.txt"]);
}
