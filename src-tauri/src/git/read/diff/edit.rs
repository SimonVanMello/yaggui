//! The working tree file behind an unstaged diff, as the diff view's editor loads and saves
//! it. Only plain UTF-8 text files are offered: anything the editor could not write back
//! byte for byte (binary, another encoding, mixed line endings, LFS, symlinks) is refused.

use std::path::PathBuf;

use gix::ObjectId;
use gix::bstr::BStr;
use gix::object::tree::EntryKind;
use serde::{Deserialize, Serialize};
use specta::Type;

use super::text::{self, MAX_RENDER_BYTES};
use super::types::{DiffTarget, LineEnding};
use super::{blob_id, fs_path, gix, invalid, lfs_content, sides, validate_path, worktree_root};
use crate::git::errors::{BackendError, YagguiError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeFile {
    /// Content on disk, line breaks as they are.
    pub text: String,
    /// Index version the editor diffs against, decoded for display; `None` when untracked.
    pub original: Option<String>,
    /// Identifies the content read, so a save does not overwrite a newer one.
    pub version: String,
    pub line_ending: LineEnding,
}

struct Editable {
    full: PathBuf,
    bytes: Vec<u8>,
    original: Option<ObjectId>,
}

fn not_editable(path: &str, en: &str, fr: &str) -> YagguiError {
    invalid(
        format!("\"{path}\" cannot be edited here: {en}."),
        format!("« {path} » ne peut pas être modifié ici : {fr}."),
    )
}

fn editable(repo: &gix::Repository, path: &str) -> Result<Editable, YagguiError> {
    validate_path(path)?;
    let git_path = BStr::new(path.as_bytes());
    let (old, new, conflicted) = sides(repo, &DiffTarget::Unstaged, git_path, git_path)?;
    if conflicted {
        return Err(YagguiError::unresolved_conflicts());
    }
    let Some(new) = new else {
        return Err(not_editable(path, "it was deleted", "il a été supprimé"));
    };
    if !matches!(new.kind, EntryKind::Blob | EntryKind::BlobExecutable) {
        return Err(not_editable(
            path,
            "it is not a regular file",
            "ce n'est pas un fichier ordinaire",
        ));
    }
    let root = worktree_root(repo)?;
    let old = old.filter(|s| matches!(s.kind, EntryKind::Blob | EntryKind::BlobExecutable));
    if lfs_content(
        repo,
        Some(&root),
        old.as_ref().map(|s| (s, git_path)),
        Some((&new, git_path)),
    )?
    .is_some()
    {
        return Err(not_editable(
            path,
            "it is stored with Git LFS",
            "il est stocké avec Git LFS",
        ));
    }
    let full = root.join(fs_path(git_path));
    let io = |err| BackendError::io(format!("cannot read {}", full.display()), err);
    if std::fs::metadata(&full).map_err(io)?.len() > MAX_RENDER_BYTES {
        return Err(not_editable(path, "it is too large", "il est trop gros"));
    }
    let bytes = std::fs::read(&full).map_err(io)?;
    let Ok(content) = std::str::from_utf8(&bytes) else {
        return Err(not_editable(
            path,
            "it is not UTF-8 text",
            "ce n'est pas du texte UTF-8",
        ));
    };
    if content.contains('\0') {
        return Err(not_editable(path, "it is binary", "il est binaire"));
    }
    if text::line_ending(content) == LineEnding::Mixed {
        return Err(not_editable(
            path,
            "it mixes LF and CRLF line endings",
            "il mélange les fins de ligne LF et CRLF",
        ));
    }
    Ok(Editable {
        full,
        bytes,
        original: old.map(|s| s.id),
    })
}

/// The working tree content of `path` and its index version.
pub fn read(repo: &gix::Repository, path: &str) -> Result<WorktreeFile, YagguiError> {
    let file = editable(repo, path)?;
    let original = file
        .original
        .map(|id| -> Result<String, YagguiError> {
            let blob = repo.find_blob(id).map_err(gix("read the index version"))?;
            Ok(text::decode(&blob.data).0.into_owned())
        })
        .transpose()?;
    let version = blob_id(repo, &file.bytes)?.to_string();
    let text = String::from_utf8(file.bytes)
        .map_err(|_| BackendError::Invariant("an editable file is checked to be UTF-8".into()))?;
    Ok(WorktreeFile {
        line_ending: text::line_ending(&text),
        text,
        original,
        version,
    })
}

/// Writes `content` to `path` if it still holds `version`, and returns the version of what
/// was written.
pub fn save(
    repo: &gix::Repository,
    path: &str,
    content: &str,
    version: &str,
) -> Result<String, YagguiError> {
    let file = editable(repo, path)?;
    if ObjectId::from_hex(version.as_bytes()).ok() != Some(blob_id(repo, &file.bytes)?) {
        return Err(YagguiError::file_changed(path));
    }
    std::fs::write(&file.full, content)
        .map_err(|err| BackendError::io(format!("cannot write {}", file.full.display()), err))?;
    Ok(blob_id(repo, content.as_bytes())?.to_string())
}
