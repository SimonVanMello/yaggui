//! Layout of a repository's view (sidebar sections, graph columns), kept per repository.

use rusqlite::{OptionalExtension, params};

use super::Store;
use crate::git::errors::YagguiError;

/// Bound on the stored JSON: the front keeps it far below (a few hundred expanded nodes).
pub const MAX_REPO_UI_STATE: usize = 64 * 1024;

impl Store {
    /// The saved layout of a repository, as written by the front; `None` before the first save.
    pub fn repo_ui_state(&self, repo_id: u32) -> Result<Option<String>, YagguiError> {
        let conn = self.conn();
        Ok(conn
            .query_row(
                "SELECT ui_state FROM repo_ui_state WHERE repo_id = ?1",
                params![i64::from(repo_id)],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Replaces the layout of a known repository (an unknown one is ignored).
    pub fn set_repo_ui_state(&self, repo_id: u32, ui_state: &str) -> Result<(), YagguiError> {
        if ui_state.len() > MAX_REPO_UI_STATE {
            return Err(YagguiError::invalid_argument(
                "The layout of the repository is too large to be saved.",
                "La disposition du dépôt est trop volumineuse pour être enregistrée.",
            ));
        }
        self.conn().execute(
            "INSERT INTO repo_ui_state (repo_id, ui_state)
             SELECT id, ?2 FROM repos WHERE id = ?1
             ON CONFLICT(repo_id) DO UPDATE SET ui_state = excluded.ui_state",
            params![i64::from(repo_id), ui_state],
        )?;
        Ok(())
    }
}
