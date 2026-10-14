//! Payloads of the submodule, worktree and LFS commands (F-260 to F-262).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::git::read::state::DirtyState;

/// `git submodule update` on some or all submodules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleUpdateRequest {
    /// Submodule paths (`SubmoduleRef::path`); empty for every submodule.
    pub paths: Vec<String>,
    /// `--init`: clone and register the submodules not initialized yet.
    pub init: bool,
    /// `--recursive`: also the submodules of the submodules.
    pub recursive: bool,
}

/// Branch checked out in a new worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorktreeBranch {
    /// A local branch not checked out in any worktree.
    Existing { name: String },
    /// A new branch created at `start` (a revision: branch, tag, SHA).
    New { name: String, start: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorktreeRequest {
    /// Absolute path of the new worktree: a folder that does not exist yet, or an empty one.
    pub path: String,
    pub branch: WorktreeBranch,
}

/// What removing a worktree would do, for its confirmation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemovePreview {
    /// Absolute path of the worktree, as listed in `WorktreeRef::path`.
    pub path: String,
    /// Branch checked out there: it stays in the repository.
    pub branch: Option<String>,
    /// Local changes that a forced removal would lose (zero when the folder is missing).
    pub dirty: DirtyState,
    pub locked: bool,
    /// The folder no longer exists: removing only forgets the worktree.
    pub missing: bool,
}

/// Git LFS in this repository (F-262).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LfsStatus {
    /// `git lfs version` output (`git-lfs/3.4.1 …`), `None` when `git lfs` is not installed.
    pub version: Option<String>,
    /// Patterns routed to LFS by the root `.gitattributes` (`*.psd`…), in file order.
    pub patterns: Vec<String>,
    /// Some attributes file of the repository mentions LFS (patterns may be in subfolders).
    pub used: bool,
}
