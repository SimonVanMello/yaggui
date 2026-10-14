//! State of the submodules (F-260): recorded commit, checked out commit, local changes.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::git::errors::{BackendError, YagguiError};

/// Live state of one submodule, next to its `SubmoduleRef` (same `path`). Separate from the
/// refs listing: knowing whether a submodule has local changes runs a status inside it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleStatus {
    /// Path relative to the worktree root, as in `SubmoduleRef::path`.
    pub path: String,
    /// Absolute path of the submodule's working tree, to open it in a tab.
    pub absolute_path: String,
    /// Commit recorded by the superproject (its index), `None` if not recorded.
    pub expected: Option<String>,
    /// Commit checked out in the submodule, `None` when it is not initialized.
    pub head: Option<String>,
    /// The submodule is cloned and checked out.
    pub initialized: bool,
    /// The submodule's working tree or index has changes (untracked files included).
    pub dirty: bool,
}

/// Every submodule of `.gitmodules`, sorted by path; unreadable entries are skipped (logged).
pub fn submodule_statuses(repo: &gix::Repository) -> Result<Vec<SubmoduleStatus>, YagguiError> {
    let Some(root) = repo.workdir() else {
        return Ok(Vec::new());
    };
    let modules = match repo.submodules() {
        Ok(Some(modules)) => modules,
        Ok(None) => return Ok(Vec::new()),
        Err(err) => {
            tracing::warn!(error = %err, "cannot read .gitmodules");
            return Ok(Vec::new());
        }
    };
    let mut out = Vec::new();
    for module in modules {
        let Ok(path) = module.path() else { continue };
        let path = path.to_string();
        let expected = module.index_id().ok().flatten().map(|id| id.to_string());
        let opened = module
            .state()
            .is_ok_and(|s| s.repository_exists && s.worktree_checkout)
            .then(|| module.open().ok().flatten())
            .flatten();
        let (head, dirty) = match &opened {
            Some(sub) => (
                sub.head_id().ok().map(|id| id.to_string()),
                has_changes(sub).unwrap_or_else(|err| {
                    tracing::warn!(path, error = %err, "submodule status failed");
                    false
                }),
            ),
            None => (None, false),
        };
        out.push(SubmoduleStatus {
            absolute_path: root.join(&path).display().to_string(),
            initialized: opened.is_some(),
            path,
            expected,
            head,
            dirty,
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Stops at the first change: only "any change" matters here.
fn has_changes(repo: &gix::Repository) -> Result<bool, YagguiError> {
    let gix = |e| BackendError::gix("submodule status", e);
    let mut iter = repo
        .status(gix::progress::Discard)
        .map_err(gix)?
        .untracked_files(gix::status::UntrackedFiles::Collapsed)
        .index_worktree_rewrites(None)
        .into_iter(Vec::<gix::bstr::BString>::new())
        .map_err(gix)?;
    match iter.next() {
        Some(item) => item.map(|_| true).map_err(|e| gix(e).into()),
        None => Ok(false),
    }
}
