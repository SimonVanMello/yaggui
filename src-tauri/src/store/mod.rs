//! SQLite persistence: repos, tabs, preferences.

mod commit_prefs;
mod graph_filters;
pub mod keybindings;
mod migrations;
mod types;
mod workspaces;

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};

use crate::git::errors::{BackendError, YagguiError};
pub use commit_prefs::{
    CommitTemplate, IdentityProfile, MAX_COMMIT_TEMPLATE, RECENT_MESSAGES_KEPT, RecentCommitMessage,
};
pub use types::*;
pub use workspaces::{MAX_WORKSPACE_NAME, Workspace};

const PREF_THEME: &str = "theme";
const PREF_STYLE: &str = "style";
const PREF_EDITOR: &str = "editor";
const PREF_DIFF_TOOL: &str = "diff_tool";
const PREF_MERGE_TOOL: &str = "merge_tool";
const PREF_LOCALE: &str = "locale";
const PREF_TERMINAL: &str = "terminal";
const PREF_TERMINAL_MODE: &str = "terminal_mode";
const PREF_DIFF_VIEW: &str = "diff_view";
const PREF_DIFF_OPTIONS: &str = "diff_options";
const PREF_HIGH_CONTRAST: &str = "high_contrast";
const PREF_DENSITY: &str = "density";
const PREF_UI_FONT: &str = "ui_font";
const PREF_CODE_FONT: &str = "code_font";
const PREF_FONT_SIZE: &str = "font_size";
const PREF_GIT_PATH: &str = "git_path";
const PREF_AUTO_FETCH: &str = "auto_fetch";
const PREF_AUTO_FETCH_MINUTES: &str = "auto_fetch_minutes";
const PREF_PRUNE: &str = "prune";
const PREF_PULL_STRATEGY: &str = "pull_strategy";
const PREF_PROTECTED_BRANCHES: &str = "protected_branches";
const PREF_DISABLED_CONFIRMATIONS: &str = "disabled_confirmations";
const PREF_GRAVATAR: &str = "gravatar";
/// Folders remembered for the clone / init dialogs.
const RECENT_DIRS_KEPT: i64 = 10;
const META_LEGACY_MIGRATED: &str = "legacy_preferences_migrated";

/// File name of the database inside the app config folder.
pub const DB_FILE: &str = "yaggui.db";

/// Thread-safe handle on the app database. Queries are small and fast: one connection
/// behind a mutex is enough.
pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    /// Opens (or creates) the database at `path` and applies pending migrations.
    pub fn open(path: &Path) -> Result<Self, YagguiError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                YagguiError::storage(
                    BackendError::io(format!("cannot create {}", parent.display()), e).chain(),
                )
            })?;
        }
        Self::init(Connection::open(path)?)
    }

    /// In-memory database, for tests.
    pub fn open_in_memory() -> Result<Self, YagguiError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self, YagguiError> {
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(2))?;
        migrations::apply(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        // SQLite keeps the database consistent even if a thread panicked mid-call.
        self.conn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    // ---- Repos -------------------------------------------------------------------------

    /// Records an opening of `path` (inserting it if new) and returns its id.
    pub fn touch_repo(&self, path: &str, name: &str) -> Result<u32, YagguiError> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO repos (path, name, last_opened_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(path) DO UPDATE SET last_opened_at = excluded.last_opened_at",
            params![path, name, now()],
        )?;
        let id: i64 = conn.query_row("SELECT id FROM repos WHERE path = ?1", [path], |row| {
            row.get(0)
        })?;
        to_id(id)
    }

    pub fn repo(&self, id: u32) -> Result<Option<KnownRepo>, YagguiError> {
        let conn = self.conn();
        let repo = conn
            .query_row(
                "SELECT id, path, name, favorite, last_opened_at FROM repos WHERE id = ?1",
                [id],
                row_to_repo,
            )
            .optional()?;
        Ok(repo)
    }

    /// Known repos, most recently opened first.
    pub fn list_repos(&self) -> Result<Vec<KnownRepo>, YagguiError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, path, name, favorite, last_opened_at FROM repos
             ORDER BY last_opened_at DESC, id DESC",
        )?;
        let repos = stmt
            .query_map([], row_to_repo)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(repos)
    }

    pub fn set_favorite(&self, id: u32, favorite: bool) -> Result<(), YagguiError> {
        let changed = self.conn().execute(
            "UPDATE repos SET favorite = ?2 WHERE id = ?1",
            params![id, favorite],
        )?;
        if changed == 0 {
            return Err(unknown_repo(id));
        }
        Ok(())
    }

    /// Removes the repo from the known list; tabs pointing to it become "new tab" tabs.
    pub fn forget_repo(&self, id: u32) -> Result<(), YagguiError> {
        self.conn()
            .execute("DELETE FROM repos WHERE id = ?1", [id])?;
        Ok(())
    }

    // ---- Tabs --------------------------------------------------------------------------

    pub fn tabs(&self) -> Result<TabsState, YagguiError> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare("SELECT tab_id, repo_id, ui_state FROM tabs ORDER BY position")?;
        let tabs = stmt
            .query_map([], |row| {
                let repo_id: Option<i64> = row.get(1)?;
                Ok(Tab {
                    id: row.get(0)?,
                    repo_id: repo_id.and_then(|id| u32::try_from(id).ok()),
                    ui_state: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let active_tab_id = get_meta(&conn, "active_tab_id")?;
        let active_tab_id = active_tab_id.filter(|id| tabs.iter().any(|t| &t.id == id));
        Ok(TabsState {
            tabs,
            active_tab_id,
        })
    }

    pub fn save_tabs(&self, state: &TabsState) -> Result<(), YagguiError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM tabs", [])?;
        {
            let mut insert = tx.prepare(
                "INSERT INTO tabs (position, tab_id, repo_id, ui_state)
                 VALUES (?1, ?2, (SELECT id FROM repos WHERE id = ?3), ?4)",
            )?;
            for (position, tab) in (0_i64..).zip(&state.tabs) {
                insert.execute(params![position, tab.id, tab.repo_id, tab.ui_state])?;
            }
        }
        match &state.active_tab_id {
            Some(id) => set_meta(&tx, "active_tab_id", id)?,
            None => {
                tx.execute("DELETE FROM meta WHERE key = 'active_tab_id'", [])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    // ---- Preferences -------------------------------------------------------------------

    pub fn preferences(&self) -> Result<Preferences, YagguiError> {
        let conn = self.conn();
        let mut prefs = Preferences::default();
        if let Some(theme) = get_pref(&conn, PREF_THEME)? {
            prefs.theme = theme;
        }
        prefs.locale = get_pref(&conn, PREF_LOCALE)?;
        prefs.terminal = get_pref(&conn, PREF_TERMINAL)?;
        if let Some(mode) = get_pref(&conn, PREF_TERMINAL_MODE)? {
            prefs.terminal_mode = mode;
        }
        if let Some(view) = get_pref(&conn, PREF_DIFF_VIEW)? {
            prefs.diff_view = view;
        }
        macro_rules! load {
            ($field:ident, $key:expr) => {
                if let Some(value) = get_pref(&conn, $key)? {
                    prefs.$field = value;
                }
            };
        }
        load!(style, PREF_STYLE);
        prefs.editor = get_pref(&conn, PREF_EDITOR)?;
        prefs.diff_tool = get_pref(&conn, PREF_DIFF_TOOL)?;
        prefs.merge_tool = get_pref(&conn, PREF_MERGE_TOOL)?;
        load!(high_contrast, PREF_HIGH_CONTRAST);
        load!(density, PREF_DENSITY);
        load!(font_size, PREF_FONT_SIZE);
        load!(auto_fetch, PREF_AUTO_FETCH);
        load!(auto_fetch_minutes, PREF_AUTO_FETCH_MINUTES);
        load!(prune, PREF_PRUNE);
        prefs.pull_strategy = get_pref(&conn, PREF_PULL_STRATEGY)?;
        load!(protected_branches, PREF_PROTECTED_BRANCHES);
        load!(disabled_confirmations, PREF_DISABLED_CONFIRMATIONS);
        load!(diff_options, PREF_DIFF_OPTIONS);
        load!(gravatar, PREF_GRAVATAR);
        prefs.ui_font = get_pref(&conn, PREF_UI_FONT)?;
        prefs.code_font = get_pref(&conn, PREF_CODE_FONT)?;
        prefs.git_path = get_pref(&conn, PREF_GIT_PATH)?;
        // A value edited by hand or written by a newer version must not break the app.
        if !FONT_SIZE_RANGE.contains(&prefs.font_size) {
            prefs.font_size = DEFAULT_FONT_SIZE;
        }
        if !AUTO_FETCH_RANGE.contains(&prefs.auto_fetch_minutes) {
            prefs.auto_fetch_minutes = DEFAULT_AUTO_FETCH_MINUTES;
        }
        Ok(prefs)
    }

    /// Stores the preferences after checking them (ranges, lengths). The Git path is checked
    /// by the caller, which can run the binary.
    pub fn set_preferences(&self, prefs: &Preferences) -> Result<Preferences, YagguiError> {
        let prefs = prefs.normalized()?;
        {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            set_pref(&tx, PREF_THEME, &prefs.theme)?;
            set_pref(&tx, PREF_LOCALE, &prefs.locale)?;
            set_pref(&tx, PREF_TERMINAL, &prefs.terminal)?;
            set_pref(&tx, PREF_TERMINAL_MODE, &prefs.terminal_mode)?;
            set_pref(&tx, PREF_DIFF_VIEW, &prefs.diff_view)?;
            set_pref(&tx, PREF_DIFF_OPTIONS, &prefs.diff_options)?;
            set_pref(&tx, PREF_STYLE, &prefs.style)?;
            set_pref(&tx, PREF_EDITOR, &prefs.editor)?;
            set_pref(&tx, PREF_DIFF_TOOL, &prefs.diff_tool)?;
            set_pref(&tx, PREF_MERGE_TOOL, &prefs.merge_tool)?;
            set_pref(&tx, PREF_HIGH_CONTRAST, &prefs.high_contrast)?;
            set_pref(&tx, PREF_DENSITY, &prefs.density)?;
            set_pref(&tx, PREF_UI_FONT, &prefs.ui_font)?;
            set_pref(&tx, PREF_CODE_FONT, &prefs.code_font)?;
            set_pref(&tx, PREF_FONT_SIZE, &prefs.font_size)?;
            set_pref(&tx, PREF_GIT_PATH, &prefs.git_path)?;
            set_pref(&tx, PREF_AUTO_FETCH, &prefs.auto_fetch)?;
            set_pref(&tx, PREF_AUTO_FETCH_MINUTES, &prefs.auto_fetch_minutes)?;
            set_pref(&tx, PREF_PRUNE, &prefs.prune)?;
            set_pref(&tx, PREF_PULL_STRATEGY, &prefs.pull_strategy)?;
            set_pref(&tx, PREF_PROTECTED_BRANCHES, &prefs.protected_branches)?;
            set_pref(
                &tx,
                PREF_DISABLED_CONFIRMATIONS,
                &prefs.disabled_confirmations,
            )?;
            set_pref(&tx, PREF_GRAVATAR, &prefs.gravatar)?;
            tx.commit()?;
        }
        self.preferences()
    }

    // ---- Recent folders ----------------------------------------------------------------

    /// Remembers `dir` as the folder the user last cloned or created a repository in.
    pub fn touch_recent_dir(&self, dir: &str) -> Result<(), YagguiError> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO recent_dirs (path, used_at) VALUES (?1, ?2)
             ON CONFLICT(path) DO UPDATE SET used_at = excluded.used_at",
            params![dir, now()],
        )?;
        conn.execute(
            "DELETE FROM recent_dirs WHERE path NOT IN
             (SELECT path FROM recent_dirs ORDER BY used_at DESC, rowid DESC LIMIT ?1)",
            [RECENT_DIRS_KEPT],
        )?;
        Ok(())
    }

    /// Folder used last, if it still exists.
    pub fn last_recent_dir(&self) -> Result<Option<String>, YagguiError> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare("SELECT path FROM recent_dirs ORDER BY used_at DESC, rowid DESC")?;
        let dirs = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(dirs.into_iter().find(|dir| Path::new(dir).is_dir()))
    }

    /// Imports the `localStorage` values the first time it is called, then never again.
    pub fn migrate_legacy_preferences(
        &self,
        legacy: &LegacyPreferences,
    ) -> Result<Preferences, YagguiError> {
        {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            if get_meta(&tx, META_LEGACY_MIGRATED)?.is_none() {
                if let Some(theme) = legacy.theme {
                    set_pref(&tx, PREF_THEME, &theme)?;
                }
                if let Some(locale) = legacy.locale {
                    set_pref(&tx, PREF_LOCALE, &Some(locale))?;
                }
                set_meta(&tx, META_LEGACY_MIGRATED, "1")?;
            }
            tx.commit()?;
        }
        self.preferences()
    }
}

fn row_to_repo(row: &rusqlite::Row<'_>) -> rusqlite::Result<KnownRepo> {
    let id: i64 = row.get(0)?;
    let path: String = row.get(1)?;
    let last_opened_at: i64 = row.get(4)?;
    Ok(KnownRepo {
        id: u32::try_from(id).unwrap_or_default(),
        exists: Path::new(&path).is_dir(),
        path,
        name: row.get(2)?,
        favorite: row.get(3)?,
        last_opened_at: u32::try_from(last_opened_at).unwrap_or_default(),
    })
}

fn get_meta(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .optional()
}

fn set_meta(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// Preferences are stored as JSON values, one row per key, so adding a key needs no migration.
/// A value that no longer parses (renamed enum variant…) falls back to the default.
fn get_pref<T: serde::de::DeserializeOwned>(
    conn: &Connection,
    key: &str,
) -> rusqlite::Result<Option<T>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM preferences WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()?;
    Ok(raw.and_then(|raw| match serde_json::from_str(&raw) {
        Ok(value) => Some(value),
        Err(err) => {
            tracing::warn!(key, error = %err, "ignoring unreadable preference");
            None
        }
    }))
}

fn set_pref<T: serde::Serialize>(
    conn: &Connection,
    key: &str,
    value: &T,
) -> Result<(), YagguiError> {
    let raw = serde_json::to_string(value).map_err(BackendError::from)?;
    conn.execute(
        "INSERT INTO preferences (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, raw],
    )?;
    Ok(())
}

fn to_id(id: i64) -> Result<u32, YagguiError> {
    u32::try_from(id).map_err(|_| YagguiError::storage(format!("repo id out of range: {id}")))
}

fn unknown_repo(id: u32) -> YagguiError {
    YagguiError::invalid_argument(
        format!("Unknown repository #{id}."),
        format!("Dépôt n°{id} inconnu."),
    )
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests;
