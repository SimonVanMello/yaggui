//! Services shared by every command, managed as Tauri state.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::events::EventSink;
use crate::git::cli::{DEFAULT_GIT, GitCli};
use crate::git::errors::YagguiError;
use crate::git::log::CommandLog;
use crate::repo::RepoManager;
use crate::repo::create::RepoCreator;
use crate::repo::scan::RepoScanner;
use crate::store::{DB_FILE, Preferences, Store};
use crate::system::avatars::{AvatarCache, CACHE_FOLDER, HttpTransport, Limits};
use crate::system::pty::PtyManager;
use crate::system::terminal;

/// Overrides the config folder (tests, isolated `xvfb-run` sessions).
pub const CONFIG_DIR_ENV: &str = "YAGGUI_CONFIG_DIR";

/// Overrides the cache folder (tests, isolated `xvfb-run` sessions).
pub const CACHE_DIR_ENV: &str = "YAGGUI_CACHE_DIR";

/// Folder of the discard backups, under the config folder.
pub const BACKUP_DIR: &str = "backups";

pub struct AppState {
    pub git: Arc<GitCli>,
    pub store: Arc<Store>,
    pub repos: Arc<RepoManager>,
    /// Clone and init: repositories that are not open yet.
    pub creator: Arc<RepoCreator>,
    /// App config folder: `keybindings.json`, the database, the backups.
    pub config_dir: PathBuf,
    /// OS cache folder of the app: the avatars, the downloaded updates.
    pub cache_dir: PathBuf,
    /// Folder scans looking for repositories (F-007).
    pub scanner: Arc<RepoScanner>,
    /// Integrated terminals (F-267).
    pub ptys: Arc<PtyManager>,
    /// Gravatar images on disk, in the OS cache folder (F-033).
    pub avatars: Arc<AvatarCache>,
}

impl AppState {
    /// `config_dir` holds the discard backups (`backups/`), `cache_dir` the avatars.
    pub fn new(
        store: Store,
        sink: Arc<dyn EventSink>,
        config_dir: &Path,
        cache_dir: &Path,
    ) -> Self {
        let git = Arc::new(GitCli::new(Arc::new(CommandLog::new()), Arc::clone(&sink)));
        let store = Arc::new(store);
        apply_stored_git_path(&git, &store);
        let creator = Arc::new(RepoCreator::new(
            Arc::clone(&git),
            Arc::clone(&store),
            Arc::clone(&sink),
        ));
        let scanner = Arc::new(RepoScanner::new(Arc::clone(&store), Arc::clone(&sink)));
        let ptys = Arc::new(PtyManager::new(Arc::clone(&sink)));
        let repos = Arc::new(
            RepoManager::new(Arc::clone(&git), Arc::clone(&store), sink)
                .with_backup_dir(config_dir.join(BACKUP_DIR)),
        );
        Self {
            git,
            store,
            repos,
            creator,
            config_dir: config_dir.to_path_buf(),
            cache_dir: cache_dir.to_path_buf(),
            scanner,
            ptys,
            avatars: Arc::new(AvatarCache::new(
                cache_dir.join(CACHE_FOLDER),
                Arc::new(HttpTransport::new()),
                Limits::default(),
            )),
        }
    }
}

/// Validates and stores the preferences, and applies the Git path. A Git path that does not
/// exist or does not answer to `--version` is refused, and nothing is saved.
pub fn save_preferences(
    git: &GitCli,
    store: &Store,
    preferences: Preferences,
) -> Result<Preferences, YagguiError> {
    let preferences = Preferences {
        terminal: terminal::validate_preference(preferences.terminal.as_deref())?,
        ..preferences
    }
    .normalized()?;
    // A path saved earlier is not checked again: a Git that vanished since must not block
    // saving an unrelated preference (the screen shows the problem).
    let changed = store.preferences()?.git_path != preferences.git_path;
    if changed && let Some(path) = &preferences.git_path {
        git.probe(Path::new(path))?;
    }
    let stored = store.set_preferences(&preferences)?;
    if changed {
        git.set_binary(
            stored
                .git_path
                .as_deref()
                .map_or_else(|| PathBuf::from(DEFAULT_GIT), PathBuf::from),
        );
    }
    Ok(stored)
}

/// Uses the Git path of the preferences. A path that stopped working (Git uninstalled,
/// moved) falls back to the one on the `PATH`, so the app still starts.
fn apply_stored_git_path(git: &GitCli, store: &Store) {
    let Some(path) = store.preferences().ok().and_then(|p| p.git_path) else {
        return;
    };
    match git.probe(Path::new(&path)) {
        Ok(version) => {
            tracing::info!(path, version, "using the configured git");
            git.set_binary(path);
        }
        Err(err) => tracing::warn!(path, error = %err, "configured git is unusable, using PATH"),
    }
}

/// The app config folder (`$XDG_CONFIG_HOME/dev.tropico.yaggui`,
/// `~/Library/Application Support/dev.tropico.yaggui`, `%APPDATA%\dev.tropico.yaggui`),
/// unless `YAGGUI_CONFIG_DIR` overrides it.
pub fn config_dir(app_config_dir: PathBuf) -> PathBuf {
    std::env::var_os(CONFIG_DIR_ENV).map_or(app_config_dir, PathBuf::from)
}

/// The OS cache folder (`~/.cache/dev.tropico.yaggui`, `~/Library/Caches/dev.tropico.yaggui`,
/// `%LOCALAPPDATA%\dev.tropico.yaggui`), unless `YAGGUI_CACHE_DIR` overrides it. Everything in
/// it can be deleted: it is rebuilt on demand.
pub fn cache_dir(app_cache_dir: PathBuf) -> PathBuf {
    std::env::var_os(CACHE_DIR_ENV).map_or(app_cache_dir, PathBuf::from)
}

/// Opens the database; falls back to an in-memory one so the app still starts
/// (preferences and recents are then not persisted).
pub fn open_store(config_dir: &Path) -> Store {
    let path = config_dir.join(DB_FILE);
    match Store::open(&path) {
        Ok(store) => store,
        Err(err) => {
            tracing::error!(error = %err, path = %path.display(), "cannot open the database, using memory");
            match Store::open_in_memory() {
                Ok(store) => store,
                Err(err) => fatal_store(&err),
            }
        }
    }
}

fn fatal_store(err: &YagguiError) -> ! {
    // In-memory SQLite only fails if the bundled library itself is broken.
    tracing::error!(error = %err, "cannot create an in-memory database");
    std::process::exit(1)
}

impl AppState {
    /// Cleans `<config>/backups/` up in the background (`repo::backups`): never on the UI
    /// thread, and a failure only logs.
    pub fn clean_backups_in_background(&self) {
        let store = Arc::clone(&self.store);
        let dir = self.config_dir.join(BACKUP_DIR);
        let spawned = std::thread::Builder::new()
            .name("backup-cleanup".into())
            .spawn(move || {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
                match crate::repo::backups::clean_backups(&store, &dir, now) {
                    Ok(done) => {
                        tracing::info!(
                            kept = done.kept,
                            removed = done.removed,
                            "backups cleaned up"
                        );
                    }
                    Err(err) => tracing::warn!(error = %err, "backups not cleaned up"),
                }
            });
        if let Err(err) = spawned {
            tracing::warn!(error = %err, "backup cleanup not started");
        }
    }
}
