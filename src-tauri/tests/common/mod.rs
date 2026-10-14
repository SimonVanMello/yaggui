//! Helpers shared by the integration tests.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use yaggui_lib::events::{BackendEvent, EventSink};
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::repo::{RepoManager, WatchMode};
use yaggui_lib::store::Store;

/// A generated fixture; the folder is deleted on drop.
pub struct Fixture {
    _dir: tempfile::TempDir,
    pub root: PathBuf,
}

impl Fixture {
    /// Runs `tests/fixtures/make-fixture.sh <scenario>` in a fresh temp folder.
    pub fn new(scenario: &str) -> Self {
        let dir = tempfile::tempdir().expect("temp dir");
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/make-fixture.sh");
        let status = Command::new("bash")
            .arg(&script)
            .arg(scenario)
            .arg(dir.path())
            .status()
            .expect("run fixture script");
        assert!(status.success(), "fixture script failed for {scenario}");
        let root = std::fs::canonicalize(dir.path()).expect("canonical temp dir");
        Self { _dir: dir, root }
    }

    /// The worktree.
    pub fn repo(&self) -> PathBuf {
        self.root.join("repo")
    }

    pub fn repo_str(&self) -> String {
        self.repo().to_string_lossy().into_owned()
    }

    /// Runs git in the worktree with the same isolated config as the fixture script.
    pub fn git(&self, args: &[&str]) {
        self.git_in(&self.repo(), args);
    }

    pub fn git_in(&self, dir: &Path, args: &[&str]) {
        let status = Command::new("git")
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
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} failed");
    }
}

/// Event sink that records everything, for assertions.
#[derive(Default)]
pub struct RecordingSink {
    events: Mutex<Vec<BackendEvent>>,
}

impl EventSink for RecordingSink {
    fn emit(&self, event: BackendEvent) {
        self.events.lock().unwrap().push(event);
    }
}

impl RecordingSink {
    pub fn events(&self) -> Vec<BackendEvent> {
        self.events.lock().unwrap().clone()
    }

    pub fn clear(&self) {
        self.events.lock().unwrap().clear();
    }

    /// Polls until `predicate` matches a recorded event or `timeout` elapses.
    pub fn wait_for(&self, timeout: Duration, predicate: impl Fn(&BackendEvent) -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < timeout {
            if self.events().iter().any(&predicate) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }
}

pub struct Backend {
    pub sink: Arc<RecordingSink>,
    pub git: Arc<GitCli>,
    pub store: Arc<Store>,
    pub repos: RepoManager,
}

/// Wires the real services on an in-memory store.
pub fn backend(watch: bool) -> Backend {
    backend_with(if watch {
        WatchMode::Enabled
    } else {
        WatchMode::Disabled
    })
}

pub fn backend_with(mode: WatchMode) -> Backend {
    let sink = Arc::new(RecordingSink::default());
    let git = Arc::new(GitCli::new(Arc::new(CommandLog::new()), sink.clone()));
    let store = Arc::new(Store::open_in_memory().unwrap());
    let repos = RepoManager::new(git.clone(), store.clone(), sink.clone());
    let repos = repos.with_watch_mode(mode);
    Backend {
        sink,
        git,
        store,
        repos,
    }
}
