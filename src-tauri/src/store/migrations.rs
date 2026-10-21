//! Versioned schema migrations, tracked with `PRAGMA user_version`.

use rusqlite::Connection;

/// Each entry upgrades the schema from version `index` to `index + 1`. Never edit a
/// released migration: append a new one.
const MIGRATIONS: &[&str] = &[
    // v1: known repos, tabs, preferences, misc key/value.
    "CREATE TABLE repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0,
        last_opened_at INTEGER NOT NULL
    );
    CREATE TABLE tabs (
        position INTEGER PRIMARY KEY,
        tab_id TEXT NOT NULL UNIQUE,
        repo_id INTEGER REFERENCES repos(id) ON DELETE SET NULL,
        ui_state TEXT
    );
    CREATE TABLE preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );",
    // v2: folders used by the clone / init dialogs.
    "CREATE TABLE recent_dirs (
        path TEXT PRIMARY KEY,
        used_at INTEGER NOT NULL
    );",
    // v3: workspaces (F-006), named groups of known repos in a chosen order.
    "CREATE TABLE workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE workspace_repos (
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, repo_id)
    );
    CREATE INDEX workspace_repos_by_repo ON workspace_repos(repo_id);",
    // v4: identity profiles (F-070), commit message templates (F-067), recent commit
    // messages per repo (F-068).
    "CREATE TABLE identity_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE commit_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE recent_commit_messages (
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        used_at INTEGER NOT NULL,
        PRIMARY KEY (repo_id, message)
    );",
    // v5: branches hidden or soloed in the graph, per repo (F-028), as JSON.
    "CREATE TABLE graph_filters (
        repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
        filter TEXT NOT NULL
    );",
    // v6: layout of a repository's view (sidebar sections, graph columns), as opaque JSON
    // written by the front, so it outlives the tab.
    "CREATE TABLE repo_ui_state (
        repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
        ui_state TEXT NOT NULL
    );",
    // v7: undo journal per repo (F-244). `seq`: the entry id, `at`: Unix ms, `redo_order`:
    // position in the redo stack (NULL: not redoable), `entry`: the `JournalEntry` as JSON,
    // `state`: what the undo restores, as JSON in `format` (unreadable formats are kept but
    // blocked).
    "CREATE TABLE undo_journal (
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        at INTEGER NOT NULL,
        undone INTEGER NOT NULL DEFAULT 0,
        redo_order INTEGER,
        entry TEXT NOT NULL,
        format INTEGER NOT NULL,
        state TEXT NOT NULL,
        PRIMARY KEY (repo_id, seq)
    );",
];

pub fn apply(conn: &mut Connection) -> rusqlite::Result<()> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    for (version, sql) in (1_i64..).zip(MIGRATIONS) {
        if version <= current {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
        tracing::info!(version, "applied store migration");
    }
    Ok(())
}

/// Schema version after all migrations.
#[cfg(test)]
pub fn latest_version() -> i64 {
    i64::try_from(MIGRATIONS.len()).unwrap_or(i64::MAX)
}

/// The SQL that creates schema `version` from scratch, to build old databases in tests.
#[cfg(test)]
pub fn schema_for_tests(version: usize) -> &'static str {
    MIGRATIONS[..version].join("\n").leak()
}
