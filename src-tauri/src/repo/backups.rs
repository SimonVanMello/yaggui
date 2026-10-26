//! Cleanup of `<app config>/backups/`: the folders discards, hard resets, single stash files,
//! `.gitignore` edits and LFS tracking fill before they touch the files (`write.rs`).
//!
//! The undo journal does not read them back (it keeps the contents as blobs), but they are
//! the copy of last resort when `git gc` has pruned those blobs, so they follow the journal's
//! bounds: a folder is kept while a journal entry refers to it (`Record::backups`), and the
//! others go once they are older than 30 days or beyond the newest 100 of their repository
//! (the repository path in their manifest). Run at startup, off the UI thread, after the
//! journals of every repository are pruned to the same bounds.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::git::errors::{BackendError, YagguiError};
use crate::store::{JOURNAL_MAX_AGE_DAYS, JOURNAL_MAX_ENTRIES, Store};

use super::journal::stored_backups;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// What a cleanup did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BackupCleanup {
    pub kept: usize,
    pub removed: usize,
}

struct Folder {
    path: PathBuf,
    id: String,
    /// Unix time, milliseconds.
    created_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    repo_path: String,
}

/// Removes the backup folders of `dir` no journal entry refers to that are out of the bounds
/// at `now_ms`. Folders whose name is not a backup id are left alone.
pub fn clean_backups(store: &Store, dir: &Path, now_ms: u64) -> Result<BackupCleanup, YagguiError> {
    let read = match std::fs::read_dir(dir) {
        Ok(read) => read,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(BackupCleanup::default());
        }
        Err(err) => {
            return Err(BackendError::io(format!("cannot read {}", dir.display()), err).into());
        }
    };
    let now = i64::try_from(now_ms).unwrap_or(i64::MAX);
    let referenced: BTreeSet<String> = store
        .journal_states(now)?
        .iter()
        .flat_map(|state| stored_backups(state))
        .collect();

    // By repository path; a folder without a readable manifest (being written, or damaged)
    // is counted on its own side.
    let mut by_repo: BTreeMap<String, Vec<Folder>> = BTreeMap::new();
    for entry in read.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        let Some(created_at) = created_at(&id) else {
            continue;
        };
        let path = entry.path();
        let repo = std::fs::read(path.join("manifest.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Manifest>(&bytes).ok())
            .map(|m| m.repo_path)
            .unwrap_or_default();
        by_repo.entry(repo).or_default().push(Folder {
            path,
            id,
            created_at,
        });
    }

    let oldest = now_ms.saturating_sub(u64::from(JOURNAL_MAX_AGE_DAYS) * DAY_MS);
    let mut cleanup = BackupCleanup::default();
    for folders in by_repo.values_mut() {
        folders.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
        for (rank, folder) in folders.iter().enumerate() {
            let out_of_bounds = folder.created_at < oldest || rank >= JOURNAL_MAX_ENTRIES as usize;
            if !out_of_bounds || referenced.contains(&folder.id) {
                cleanup.kept += 1;
                continue;
            }
            match std::fs::remove_dir_all(&folder.path) {
                Ok(()) => cleanup.removed += 1,
                Err(err) => {
                    cleanup.kept += 1;
                    tracing::warn!(path = %folder.path.display(), error = %err, "backup not removed");
                }
            }
        }
    }
    Ok(cleanup)
}

/// Creation time of a backup id (`<unix ms>-<pid>-<n>`, see `Backup::create`).
fn created_at(id: &str) -> Option<u64> {
    let mut parts = id.split('-');
    let (Some(ms), Some(pid), Some(n), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    if pid.parse::<u32>().is_err() || n.parse::<u32>().is_err() {
        return None;
    }
    ms.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_backup_ids() {
        assert_eq!(created_at("1700000000000-42-0"), Some(1_700_000_000_000));
        assert_eq!(created_at("1700000000000-42"), None);
        assert_eq!(created_at("notes"), None);
        assert_eq!(created_at("1-2-3-4"), None);
        assert_eq!(created_at("x-2-3"), None);
    }
}
