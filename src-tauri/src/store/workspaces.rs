//! Workspaces (F-006): named groups of known repos, and the repo list changes they need
//! (imports from a folder scan, relocation of a moved repo).

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use specta::Type;

use super::{KnownRepo, Store, now, to_id, unknown_repo};
use crate::git::errors::YagguiError;

/// Longest accepted workspace name, in characters.
pub const MAX_WORKSPACE_NAME: u32 = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: u32,
    pub name: String,
    /// Known repos of the workspace, in display order.
    pub repo_ids: Vec<u32>,
}

impl Store {
    /// Workspaces sorted by name (case-insensitive).
    pub fn list_workspaces(&self) -> Result<Vec<Workspace>, YagguiError> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare("SELECT id, name FROM workspaces ORDER BY name COLLATE NOCASE, id")?;
        let mut workspaces = stmt
            .query_map([], |row| {
                Ok(Workspace {
                    id: u32::try_from(row.get::<_, i64>(0)?).unwrap_or_default(),
                    name: row.get(1)?,
                    repo_ids: Vec::new(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut members: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut stmt = conn.prepare(
            "SELECT workspace_id, repo_id FROM workspace_repos ORDER BY workspace_id, position",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))?;
        for row in rows {
            let (workspace, repo) = row?;
            if let (Ok(workspace), Ok(repo)) = (u32::try_from(workspace), u32::try_from(repo)) {
                members.entry(workspace).or_default().push(repo);
            }
        }
        for workspace in &mut workspaces {
            workspace.repo_ids = members.remove(&workspace.id).unwrap_or_default();
        }
        Ok(workspaces)
    }

    pub fn workspace(&self, id: u32) -> Result<Workspace, YagguiError> {
        self.list_workspaces()?
            .into_iter()
            .find(|w| w.id == id)
            .ok_or_else(|| unknown_workspace(id))
    }

    /// Creates a workspace holding `repo_ids` (unknown ids are ignored).
    pub fn create_workspace(&self, name: &str, repo_ids: &[u32]) -> Result<Workspace, YagguiError> {
        let name = clean_name(name)?;
        let id = {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            check_unique(&tx, &name, None)?;
            tx.execute(
                "INSERT INTO workspaces (name, created_at) VALUES (?1, ?2)",
                params![name, now()],
            )?;
            let id = to_id(tx.last_insert_rowid())?;
            add_members(&tx, id, repo_ids)?;
            tx.commit()?;
            id
        };
        self.workspace(id)
    }

    pub fn rename_workspace(&self, id: u32, name: &str) -> Result<Workspace, YagguiError> {
        let name = clean_name(name)?;
        {
            let conn = self.conn();
            check_unique(&conn, &name, Some(id))?;
            let changed = conn.execute(
                "UPDATE workspaces SET name = ?2 WHERE id = ?1",
                params![id, name],
            )?;
            if changed == 0 {
                return Err(unknown_workspace(id));
            }
        }
        self.workspace(id)
    }

    /// Deletes the workspace; its repos stay known.
    pub fn delete_workspace(&self, id: u32) -> Result<(), YagguiError> {
        self.conn()
            .execute("DELETE FROM workspaces WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Appends repos to the workspace; those already in it keep their place.
    pub fn add_to_workspace(&self, id: u32, repo_ids: &[u32]) -> Result<Workspace, YagguiError> {
        {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            if !workspace_exists(&tx, id)? {
                return Err(unknown_workspace(id));
            }
            add_members(&tx, id, repo_ids)?;
            tx.commit()?;
        }
        self.workspace(id)
    }

    pub fn remove_from_workspace(&self, id: u32, repo_id: u32) -> Result<Workspace, YagguiError> {
        self.conn().execute(
            "DELETE FROM workspace_repos WHERE workspace_id = ?1 AND repo_id = ?2",
            params![id, repo_id],
        )?;
        self.workspace(id)
    }

    /// Known repo ids by path, to flag what a folder scan already knows.
    pub fn repo_ids_by_path(&self) -> Result<HashMap<String, u32>, YagguiError> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT path, id FROM repos")?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .filter_map(|(path, id)| u32::try_from(id).ok().map(|id| (path, id)))
            .collect())
    }

    /// Adds `path` to the known repos without marking it as opened (an import), and returns
    /// its id. An already known path keeps its data.
    pub fn ensure_repo(&self, path: &str, name: &str) -> Result<u32, YagguiError> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO repos (path, name, last_opened_at) VALUES (?1, ?2, 0)
             ON CONFLICT(path) DO NOTHING",
            params![path, name],
        )?;
        let id: i64 = conn.query_row("SELECT id FROM repos WHERE path = ?1", [path], |row| {
            row.get(0)
        })?;
        to_id(id)
    }

    /// Points a known repo to its new folder (F-009). If that folder is already known under
    /// another id, the two entries are merged into that one (favorite and workspaces kept),
    /// whose id is returned in the result.
    pub fn relocate_repo(&self, id: u32, path: &str, name: &str) -> Result<KnownRepo, YagguiError> {
        let target = {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            let favorite: bool = tx
                .query_row("SELECT favorite FROM repos WHERE id = ?1", [id], |row| {
                    row.get(0)
                })
                .optional()?
                .ok_or_else(|| unknown_repo(id))?;
            let other: Option<i64> = tx
                .query_row("SELECT id FROM repos WHERE path = ?1", [path], |row| {
                    row.get(0)
                })
                .optional()?;
            let target = match other.map(to_id).transpose()? {
                Some(other) if other != id => {
                    tx.execute(
                        "INSERT OR IGNORE INTO workspace_repos (workspace_id, repo_id, position)
                         SELECT workspace_id, ?2, position FROM workspace_repos WHERE repo_id = ?1",
                        params![id, other],
                    )?;
                    tx.execute(
                        "UPDATE repos SET favorite = favorite OR ?2,
                             last_opened_at = MAX(last_opened_at,
                                 (SELECT last_opened_at FROM repos WHERE id = ?3))
                         WHERE id = ?1",
                        params![other, favorite, id],
                    )?;
                    tx.execute("DELETE FROM repos WHERE id = ?1", [id])?;
                    other
                }
                _ => {
                    tx.execute(
                        "UPDATE repos SET path = ?2, name = ?3 WHERE id = ?1",
                        params![id, path, name],
                    )?;
                    id
                }
            };
            tx.commit()?;
            target
        };
        self.repo(target)?.ok_or_else(|| unknown_repo(target))
    }
}

fn add_members(conn: &Connection, workspace: u32, repo_ids: &[u32]) -> Result<(), YagguiError> {
    let mut position: i64 = conn.query_row(
        "SELECT COALESCE(MAX(position) + 1, 0) FROM workspace_repos WHERE workspace_id = ?1",
        [workspace],
        |row| row.get(0),
    )?;
    let mut insert = conn.prepare(
        "INSERT OR IGNORE INTO workspace_repos (workspace_id, repo_id, position)
         SELECT ?1, id, ?3 FROM repos WHERE id = ?2",
    )?;
    for repo in repo_ids {
        if insert.execute(params![workspace, repo, position])? > 0 {
            position += 1;
        }
    }
    Ok(())
}

fn workspace_exists(conn: &Connection, id: u32) -> rusqlite::Result<bool> {
    conn.query_row("SELECT 1 FROM workspaces WHERE id = ?1", [id], |_| Ok(()))
        .optional()
        .map(|found| found.is_some())
}

fn check_unique(conn: &Connection, name: &str, except: Option<u32>) -> Result<(), YagguiError> {
    let taken: Option<i64> = conn
        .query_row(
            "SELECT id FROM workspaces WHERE name = ?1 COLLATE NOCASE AND id IS NOT ?2",
            params![name, except],
            |row| row.get(0),
        )
        .optional()?;
    if taken.is_some() {
        return Err(YagguiError::invalid_argument(
            format!("A workspace named \"{name}\" already exists."),
            format!("Un workspace nommé « {name} » existe déjà."),
        ));
    }
    Ok(())
}

fn clean_name(name: &str) -> Result<String, YagguiError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(YagguiError::invalid_argument(
            "The workspace needs a name.",
            "Le workspace doit avoir un nom.",
        ));
    }
    let too_long = u32::try_from(name.chars().count()).map_or(true, |n| n > MAX_WORKSPACE_NAME);
    if too_long || name.chars().any(char::is_control) {
        return Err(YagguiError::invalid_argument(
            format!(
                "A workspace name has at most {MAX_WORKSPACE_NAME} characters, without control characters."
            ),
            format!(
                "Un nom de workspace compte au plus {MAX_WORKSPACE_NAME} caractères, sans caractère de contrôle."
            ),
        ));
    }
    Ok(name.to_owned())
}

fn unknown_workspace(id: u32) -> YagguiError {
    YagguiError::invalid_argument(
        format!("Unknown workspace #{id}."),
        format!("Workspace n°{id} inconnu."),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::open_in_memory().unwrap()
    }

    #[test]
    fn creates_lists_and_renames_workspaces() {
        let store = store();
        let a = store.touch_repo("/r/a", "a").unwrap();
        let b = store.touch_repo("/r/b", "b").unwrap();
        let client = store.create_workspace("  Client X ", &[b, a, 999]).unwrap();
        assert_eq!(client.name, "Client X");
        assert_eq!(client.repo_ids, vec![b, a]);
        store.create_workspace("perso", &[]).unwrap();
        let names: Vec<_> = store
            .list_workspaces()
            .unwrap()
            .into_iter()
            .map(|w| w.name)
            .collect();
        assert_eq!(names, vec!["Client X", "perso"]);

        let renamed = store.rename_workspace(client.id, "Client Y").unwrap();
        assert_eq!(renamed.repo_ids, vec![b, a]);
        // Case-insensitive uniqueness, but renaming to its own name in another case is fine.
        assert!(store.create_workspace("CLIENT y", &[]).is_err());
        assert!(store.rename_workspace(client.id, "client y").is_ok());
        assert!(store.rename_workspace(999, "z").is_err());
        assert!(store.create_workspace("   ", &[]).is_err());
        assert!(store.create_workspace(&"x".repeat(101), &[]).is_err());
    }

    #[test]
    fn adds_and_removes_members_in_order() {
        let store = store();
        let ids: Vec<u32> = ["/a", "/b", "/c"]
            .iter()
            .map(|p| store.touch_repo(p, p).unwrap())
            .collect();
        let ws = store.create_workspace("w", &[ids[0]]).unwrap();
        let ws = store
            .add_to_workspace(ws.id, &[ids[2], ids[0], ids[1]])
            .unwrap();
        assert_eq!(ws.repo_ids, vec![ids[0], ids[2], ids[1]]);
        let ws = store.remove_from_workspace(ws.id, ids[2]).unwrap();
        assert_eq!(ws.repo_ids, vec![ids[0], ids[1]]);
        assert!(store.add_to_workspace(999, &[ids[0]]).is_err());

        // Forgetting a repo removes it from its workspaces; deleting a workspace keeps repos.
        store.forget_repo(ids[0]).unwrap();
        assert_eq!(store.workspace(ws.id).unwrap().repo_ids, vec![ids[1]]);
        store.delete_workspace(ws.id).unwrap();
        assert!(store.list_workspaces().unwrap().is_empty());
        assert!(store.repo(ids[1]).unwrap().is_some());
    }

    #[test]
    fn imported_repos_are_not_marked_as_opened() {
        let store = store();
        let id = store.ensure_repo("/r/new", "new").unwrap();
        assert_eq!(store.repo(id).unwrap().unwrap().last_opened_at, 0);
        let opened = store.touch_repo("/r/opened", "opened").unwrap();
        let before = store.repo(opened).unwrap().unwrap();
        assert_eq!(store.ensure_repo("/r/opened", "other").unwrap(), opened);
        assert_eq!(store.repo(opened).unwrap().unwrap(), before);
        assert_eq!(store.repo_ids_by_path().unwrap().get("/r/new"), Some(&id));
    }

    #[test]
    fn relocates_in_place_or_merges_into_the_known_path() {
        let store = store();
        let old = store.touch_repo("/old/api", "api").unwrap();
        store.set_favorite(old, true).unwrap();
        let ws = store.create_workspace("w", &[old]).unwrap();
        let moved = store.relocate_repo(old, "/new/api2", "api2").unwrap();
        assert_eq!(
            (moved.id, moved.path.as_str(), moved.name.as_str()),
            (old, "/new/api2", "api2")
        );
        assert!(moved.favorite);

        let other = store.ensure_repo("/other/api", "api").unwrap();
        let merged = store.relocate_repo(old, "/other/api", "api").unwrap();
        assert_eq!(merged.id, other);
        assert!(merged.favorite);
        assert!(store.repo(old).unwrap().is_none());
        assert_eq!(store.workspace(ws.id).unwrap().repo_ids, vec![other]);
        assert!(store.relocate_repo(old, "/x", "x").is_err());
    }
}
