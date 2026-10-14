//! Branches hidden or soloed in the graph (F-028), kept per repository.

use rusqlite::{OptionalExtension, params};

use super::Store;
use crate::git::errors::YagguiError;
use crate::graph::types::GraphFilter;

impl Store {
    /// The filter of a repository; the default one (everything shown) when none is stored or
    /// the stored one cannot be read.
    pub fn graph_filter(&self, repo_id: u32) -> Result<GraphFilter, YagguiError> {
        let conn = self.conn();
        let json: Option<String> = conn
            .query_row(
                "SELECT filter FROM graph_filters WHERE repo_id = ?1",
                params![i64::from(repo_id)],
                |row| row.get(0),
            )
            .optional()?;
        Ok(json
            .and_then(|json| match serde_json::from_str(&json) {
                Ok(filter) => Some(filter),
                Err(err) => {
                    tracing::warn!(repo_id, error = %err, "ignoring an unreadable graph filter");
                    None
                }
            })
            .unwrap_or_default())
    }

    /// Stores the filter of a repository (removes the row when it shows everything).
    pub fn set_graph_filter(&self, repo_id: u32, filter: &GraphFilter) -> Result<(), YagguiError> {
        let conn = self.conn();
        if filter.is_empty() {
            conn.execute(
                "DELETE FROM graph_filters WHERE repo_id = ?1",
                params![i64::from(repo_id)],
            )?;
            return Ok(());
        }
        let json =
            serde_json::to_string(filter).map_err(|err| YagguiError::internal(err.to_string()))?;
        conn.execute(
            "INSERT INTO graph_filters (repo_id, filter) VALUES (?1, ?2)
             ON CONFLICT(repo_id) DO UPDATE SET filter = excluded.filter",
            params![i64::from(repo_id), json],
        )?;
        Ok(())
    }
}
