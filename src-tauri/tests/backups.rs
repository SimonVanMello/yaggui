//! Cleanup of the backup folders (`<config>/backups/`, `repo::backups`): bounded like the
//! undo journal (newest 100 per repository, 30 days), never removing a folder a journal
//! entry still refers to, and leaving alone what is not a backup.

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use common::{Fixture, RecordingSink};
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::ops::types::PathSelection;
use yaggui_lib::repo::RepoManager;
use yaggui_lib::repo::backups::{BackupCleanup, clean_backups};
use yaggui_lib::store::Store;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

struct Env {
    fx: Fixture,
    store: Arc<Store>,
    repos: RepoManager,
    id: u32,
    dir: PathBuf,
}

fn env() -> Env {
    let fx = Fixture::new("clean");
    fx.git(&["config", "user.name", "yaggui Tests"]);
    fx.git(&["config", "user.email", "tests@yaggui.dev"]);
    let store = Arc::new(Store::open(&fx.root.join("config").join("yaggui.db")).unwrap());
    let sink = Arc::new(RecordingSink::default());
    let git = GitCli::new(Arc::new(CommandLog::new()), sink.clone())
        .with_env("GIT_CONFIG_NOSYSTEM", "1")
        .with_env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        );
    let dir = fx.root.join("backups");
    let repos = RepoManager::new(Arc::new(git), Arc::clone(&store), sink)
        .without_watcher()
        .with_backup_dir(&dir);
    let id = repos.open(&fx.repo_str()).unwrap().id;
    Env {
        fx,
        store,
        repos,
        id,
        dir,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap())
        .unwrap()
}

impl Env {
    /// Discards a new untracked file; returns the id of the backup it made.
    fn discard(&self, name: &str) -> String {
        std::fs::write(self.fx.repo().join(name), "work\n").unwrap();
        self.repos
            .discard_paths(
                self.id,
                PathSelection::Paths {
                    paths: vec![name.into()],
                },
                false,
            )
            .unwrap()
            .backup_id
    }

    /// A backup folder made at `created_at` with `manifest` (copied from a real one).
    fn fake(&self, created_at: u64, manifest: &str) -> String {
        let id = format!("{created_at}-1-0");
        std::fs::create_dir_all(self.dir.join(&id)).unwrap();
        std::fs::write(self.dir.join(&id).join("manifest.json"), manifest).unwrap();
        id
    }

    fn clean(&self, now: u64) -> BackupCleanup {
        clean_backups(&self.store, &self.dir, now).unwrap()
    }

    fn exists(&self, id: &str) -> bool {
        self.dir.join(id).is_dir()
    }
}

fn manifest(dir: &Path, id: &str) -> String {
    std::fs::read_to_string(dir.join(id).join("manifest.json")).unwrap()
}

#[test]
fn keeps_journaled_backups_and_the_newest_100_of_a_repository() {
    let e = env();
    let journaled = e.discard("one.txt");
    let manifest = manifest(&e.dir, &journaled);
    let start = now_ms() + 1;
    // 105 newer backups of the same repository that no journal entry refers to.
    let fakes: Vec<_> = (0..105).map(|i| e.fake(start + i, &manifest)).collect();
    // Not a backup: never touched.
    std::fs::create_dir_all(e.dir.join("notes")).unwrap();
    std::fs::write(e.dir.join("loose.txt"), "x").unwrap();

    let done = e.clean(start + 1000);
    // The 100 newest stay, the 5 oldest fakes go; the journaled one, older still, stays.
    assert_eq!(
        done,
        BackupCleanup {
            kept: 101,
            removed: 5
        }
    );
    assert!(e.exists(&journaled));
    assert!(fakes[..5].iter().all(|id| !e.exists(id)));
    assert!(fakes[5..].iter().all(|id| e.exists(id)));
    assert!(e.exists("notes") && e.dir.join("loose.txt").is_file());

    // Undone, the entry is still in the journal (redo): its backup stays.
    e.repos.undo(e.id).unwrap();
    assert_eq!(e.clean(start + 1000).removed, 0);
    assert!(e.exists(&journaled));
}

#[test]
fn removes_what_is_older_than_30_days_once_the_journal_drops_it() {
    let e = env();
    let journaled = e.discard("one.txt");
    let manifest = manifest(&e.dir, &journaled);
    let now = now_ms();
    let old = e.fake(now - 31 * DAY_MS, &manifest);
    let recent = e.fake(now - DAY_MS, &manifest);
    // Another repository, or a manifest that cannot be read: bounded the same way.
    let elsewhere = e.fake(now - 40 * DAY_MS, r#"{"repoPath":"/elsewhere"}"#);
    let broken = e.fake(now - 41 * DAY_MS, "{");

    let done = e.clean(now + 1000);
    assert_eq!(
        done,
        BackupCleanup {
            kept: 2,
            removed: 3
        }
    );
    assert!(e.exists(&journaled) && e.exists(&recent));
    assert!(!e.exists(&old) && !e.exists(&elsewhere) && !e.exists(&broken));

    // 31 days later the journal entry is out of bounds too: nothing refers to its backup.
    let later = now + 31 * DAY_MS;
    let done = e.clean(later);
    assert_eq!(
        done,
        BackupCleanup {
            kept: 0,
            removed: 2
        }
    );
    assert!(
        e.store
            .journal_states(i64::try_from(later).unwrap())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_missing_folder_is_nothing_to_clean() {
    let e = env();
    assert!(!e.dir.exists());
    assert_eq!(e.clean(now_ms()), BackupCleanup::default());
}
