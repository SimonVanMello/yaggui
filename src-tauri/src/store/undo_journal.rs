//! Undo journal of each repository (F-244): the `OpJournal` entries, kept across sessions.
//! The store only keeps rows; `repo::journal` decides what they mean.

use rusqlite::params;

use super::Store;
use crate::git::errors::YagguiError;

/// Entries kept per repository: the oldest are dropped first.
pub const JOURNAL_MAX_ENTRIES: u32 = 100;
/// Entries older than this are dropped (when the journal is saved or loaded).
pub const JOURNAL_MAX_AGE_DAYS: u32 = 30;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// One saved journal entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredJournalRow {
    /// The entry id, unique per repository.
    pub seq: u32,
    /// When the operation finished, Unix time in milliseconds.
    pub at: i64,
    pub undone: bool,
    /// Position in the redo stack (0 first undone), `None`: not redoable.
    pub redo_order: Option<u32>,
    /// The `JournalEntry`, as JSON.
    pub entry: String,
    /// Version of the `state` encoding.
    pub format: u32,
    /// What an undo or redo restores, as JSON.
    pub state: String,
}

impl Store {
    /// The saved journal of a repository, oldest first, after dropping what is out of bounds
    /// at `now_ms`.
    pub fn load_journal(
        &self,
        repo_id: u32,
        now_ms: i64,
    ) -> Result<Vec<StoredJournalRow>, YagguiError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        prune(&tx, repo_id, now_ms)?;
        let rows = {
            let mut stmt = tx.prepare(
                "SELECT seq, at, undone, redo_order, entry, format, state FROM undo_journal
                 WHERE repo_id = ?1 ORDER BY seq",
            )?;
            stmt.query_map([i64::from(repo_id)], |row| {
                Ok(StoredJournalRow {
                    seq: row.get(0)?,
                    at: row.get(1)?,
                    undone: row.get(2)?,
                    redo_order: row.get(3)?,
                    entry: row.get(4)?,
                    format: row.get(5)?,
                    state: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?
        };
        tx.commit()?;
        Ok(rows)
    }

    /// Saves a new entry: the redo stack is cleared (a new operation ends it) and the journal
    /// bounded. An unknown repository is ignored.
    pub fn append_journal(
        &self,
        repo_id: u32,
        row: &StoredJournalRow,
        now_ms: i64,
    ) -> Result<(), YagguiError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE undo_journal SET redo_order = NULL WHERE repo_id = ?1",
            [i64::from(repo_id)],
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO undo_journal
                 (repo_id, seq, at, undone, redo_order, entry, format, state)
             SELECT id, ?2, ?3, ?4, ?5, ?6, ?7, ?8 FROM repos WHERE id = ?1",
            params![
                i64::from(repo_id),
                row.seq,
                row.at,
                row.undone,
                row.redo_order,
                row.entry,
                row.format,
                row.state
            ],
        )?;
        prune(&tx, repo_id, now_ms)?;
        tx.commit()?;
        Ok(())
    }

    /// The saved `state` of every entry of every repository, after dropping what is out of
    /// bounds at `now_ms` (as loading each journal would): what the backup cleanup keeps.
    pub fn journal_states(&self, now_ms: i64) -> Result<Vec<String>, YagguiError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let repos = {
            let mut stmt = tx.prepare("SELECT DISTINCT repo_id FROM undo_journal")?;
            stmt.query_map([], |row| row.get::<_, u32>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        for repo_id in repos {
            prune(&tx, repo_id, now_ms)?;
        }
        let states = {
            let mut stmt = tx.prepare("SELECT state FROM undo_journal")?;
            stmt.query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        tx.commit()?;
        Ok(states)
    }

    /// After an undo or redo: the entry's `undone` flag and the redo stack (`redo`: entry ids,
    /// first undone first).
    pub fn mark_journal(
        &self,
        repo_id: u32,
        seq: u32,
        undone: bool,
        redo: &[u32],
    ) -> Result<(), YagguiError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let repo = i64::from(repo_id);
        tx.execute(
            "UPDATE undo_journal SET undone = ?3 WHERE repo_id = ?1 AND seq = ?2",
            params![repo, seq, undone],
        )?;
        tx.execute(
            "UPDATE undo_journal SET redo_order = NULL WHERE repo_id = ?1",
            [repo],
        )?;
        for (order, seq) in (0_u32..).zip(redo) {
            tx.execute(
                "UPDATE undo_journal SET redo_order = ?3 WHERE repo_id = ?1 AND seq = ?2",
                params![repo, seq, order],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}

/// Drops the entries older than the age bound, then all but the newest by count.
fn prune(tx: &rusqlite::Transaction<'_>, repo_id: u32, now_ms: i64) -> rusqlite::Result<()> {
    let repo = i64::from(repo_id);
    let oldest = now_ms.saturating_sub(i64::from(JOURNAL_MAX_AGE_DAYS) * DAY_MS);
    tx.execute(
        "DELETE FROM undo_journal WHERE repo_id = ?1 AND at < ?2",
        params![repo, oldest],
    )?;
    tx.execute(
        "DELETE FROM undo_journal WHERE repo_id = ?1 AND seq NOT IN (
             SELECT seq FROM undo_journal WHERE repo_id = ?1 ORDER BY seq DESC LIMIT ?2
         )",
        params![repo, JOURNAL_MAX_ENTRIES],
    )?;
    Ok(())
}
