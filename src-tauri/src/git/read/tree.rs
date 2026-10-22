//! The tree of a commit (F-224): folder listings and file contents, read through `gix`.
//!
//! Listings are lazy per folder and paginated: a folder can hold 100k entries, and the
//! frontend only asks for the folders the user opens. Entries are sorted folders first, then
//! by name, so every page of a listing sorts the whole folder again (about 20 ms for 100k
//! entries, measured by `tree_bench`), which keeps the pages stateless on the backend.

use std::cmp::Ordering;

use gix::ObjectId;
use gix::bstr::{BStr, ByteSlice};
use gix::object::tree::EntryKind;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::git::errors::{BackendError, YagguiError};
use crate::git::read::blame::is_binary;
use crate::git::read::diff::text::{MAX_RENDER_BYTES, decode};
use crate::git::read::diff::types::TextEncoding;
use crate::git::read::diff::validate_path;
use crate::git::read::image::{MAX_IMAGE_PREVIEW, data_url, media_type};
use crate::git::read::lfs::{LfsObject, parse_pointer};
use crate::graph::resolve_commit;

/// Largest page of a folder listing.
pub const TREE_PAGE_MAX: u32 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TreeEntryKind {
    Dir,
    File,
    /// A file with the executable bit.
    Executable,
    Symlink,
    /// A submodule: the commit of another repository.
    Submodule,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    /// Name in its folder (not the full path).
    pub name: String,
    pub kind: TreeEntryKind,
    /// Object id: the blob, the subtree or the submodule commit.
    pub oid: String,
    /// Size in bytes of a file or a symlink target; `None` for folders and submodules.
    pub size: Option<f64>,
}

/// One page of a folder, folders first then by name (case-insensitive).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TreePage {
    /// The commit read, resolved (the request may name a branch or `HEAD`).
    pub rev: String,
    /// The folder listed, empty for the root.
    pub path: String,
    pub entries: Vec<TreeEntry>,
    /// Entries in the whole folder.
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TreeFileContent {
    Text {
        text: String,
        encoding: TextEncoding,
    },
    /// An image the webview can show, as a `data:` URL.
    Image {
        url: String,
    },
    /// Binary content, or an image too large to preview.
    Binary,
    /// Text above the render limit: only read when the request forces it.
    TooLarge {
        limit: f64,
    },
    /// An LFS pointer: the content lives on the LFS server, not in Git.
    Lfs {
        object: LfsObject,
    },
    Symlink {
        target: String,
    },
    Submodule {
        commit: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TreeFile {
    pub rev: String,
    pub path: String,
    pub oid: String,
    /// Size in bytes of the blob stored in Git (the pointer for an LFS file).
    pub size: f64,
    pub executable: bool,
    pub content: TreeFileContent,
}

fn kind_of(mode: gix::objs::tree::EntryMode) -> TreeEntryKind {
    match mode.kind() {
        EntryKind::Tree => TreeEntryKind::Dir,
        EntryKind::Blob => TreeEntryKind::File,
        EntryKind::BlobExecutable => TreeEntryKind::Executable,
        EntryKind::Link => TreeEntryKind::Symlink,
        EntryKind::Commit => TreeEntryKind::Submodule,
    }
}

fn read_err(err: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> BackendError {
    BackendError::gix("read the commit tree", err)
}

fn not_found(path: &str, rev: &str) -> YagguiError {
    YagguiError::invalid_argument(
        format!("\"{path}\" does not exist in {rev}."),
        format!("« {path} » n'existe pas dans {rev}."),
    )
}

fn root_tree<'r>(
    repo: &'r gix::Repository,
    commit: ObjectId,
) -> Result<gix::Tree<'r>, YagguiError> {
    Ok(repo
        .find_commit(commit)
        .and_then(|c| c.tree())
        .map_err(read_err)?)
}

fn dirs_first(
    a: &(TreeEntryKind, &BStr, ObjectId),
    b: &(TreeEntryKind, &BStr, ObjectId),
) -> Ordering {
    let is_dir = |kind: TreeEntryKind| kind == TreeEntryKind::Dir;
    is_dir(b.0).cmp(&is_dir(a.0)).then_with(|| {
        let (x, y) = (
            a.1.to_str_lossy().to_lowercase(),
            b.1.to_str_lossy().to_lowercase(),
        );
        x.cmp(&y).then_with(|| a.1.cmp(b.1))
    })
}

/// Entries `start .. start + limit` of the folder `path` (empty: the root) of `rev`.
pub fn list(
    repo: &gix::Repository,
    rev: &str,
    path: &str,
    start: u32,
    limit: u32,
) -> Result<TreePage, YagguiError> {
    let commit = resolve_commit(repo, rev)?;
    let root = root_tree(repo, commit)?;
    let tree = if path.is_empty() {
        root
    } else {
        validate_path(path)?;
        let entry = root
            .lookup_entry_by_path(path)
            .map_err(read_err)?
            .filter(|entry| entry.mode().is_tree())
            .ok_or_else(|| not_found(path, rev))?;
        entry
            .object()
            .map_err(read_err)?
            .try_into_tree()
            .map_err(read_err)?
    };
    let decoded = tree.decode().map_err(read_err)?;
    let mut sorted: Vec<(TreeEntryKind, &BStr, ObjectId)> = decoded
        .entries
        .iter()
        .map(|entry| (kind_of(entry.mode), entry.filename, entry.oid.to_owned()))
        .collect();
    sorted.sort_by(dirs_first);
    let total = u32::try_from(sorted.len()).unwrap_or(u32::MAX);
    let limit = limit.clamp(1, TREE_PAGE_MAX) as usize;
    let entries = sorted
        .iter()
        .skip(start as usize)
        .take(limit)
        .map(|&(kind, name, oid)| TreeEntry {
            name: name.to_str_lossy().into_owned(),
            kind,
            oid: oid.to_string(),
            size: matches!(
                kind,
                TreeEntryKind::File | TreeEntryKind::Executable | TreeEntryKind::Symlink
            )
            .then(|| {
                #[allow(clippy::cast_precision_loss)] // Shown rounded.
                repo.find_header(oid).ok().map(|h| h.size() as f64)
            })
            .flatten(),
        })
        .collect();
    Ok(TreePage {
        rev: commit.to_string(),
        path: path.to_owned(),
        entries,
        total,
    })
}

/// A file of the tree, as stored in Git.
pub struct Blob {
    pub rev: ObjectId,
    pub oid: ObjectId,
    pub kind: TreeEntryKind,
    pub data: Vec<u8>,
}

/// The blob (or symlink target, or submodule commit id as text) at `path` of `rev`.
pub fn read_blob(repo: &gix::Repository, rev: &str, path: &str) -> Result<Blob, YagguiError> {
    validate_path(path)?;
    let commit = resolve_commit(repo, rev)?;
    let entry = root_tree(repo, commit)?
        .lookup_entry_by_path(path)
        .map_err(read_err)?
        .filter(|entry| !entry.mode().is_tree())
        .ok_or_else(|| not_found(path, rev))?;
    let kind = kind_of(entry.mode());
    let oid = entry.object_id();
    let data = if kind == TreeEntryKind::Submodule {
        oid.to_string().into_bytes()
    } else {
        entry.object().map_err(read_err)?.detach().data
    };
    Ok(Blob {
        rev: commit,
        oid,
        kind,
        data,
    })
}

/// Content of the file at `path` of `rev` for display. `force` reads a text above
/// [`MAX_RENDER_BYTES`].
pub fn file(
    repo: &gix::Repository,
    rev: &str,
    path: &str,
    force: bool,
) -> Result<TreeFile, YagguiError> {
    validate_path(path)?;
    let commit = resolve_commit(repo, rev)?;
    let entry = root_tree(repo, commit)?
        .lookup_entry_by_path(path)
        .map_err(read_err)?
        .filter(|entry| !entry.mode().is_tree())
        .ok_or_else(|| not_found(path, rev))?;
    let kind = kind_of(entry.mode());
    let oid = entry.object_id();
    let wrap = |size: usize, content| {
        #[allow(clippy::cast_precision_loss)] // Shown rounded.
        TreeFile {
            rev: commit.to_string(),
            path: path.to_owned(),
            oid: oid.to_string(),
            size: size as f64,
            executable: kind == TreeEntryKind::Executable,
            content,
        }
    };
    if kind == TreeEntryKind::Submodule {
        return Ok(wrap(
            0,
            TreeFileContent::Submodule {
                commit: oid.to_string(),
            },
        ));
    }
    // The header gives the size without inflating a blob that will not be shown.
    let size = repo.find_header(oid).map_err(read_err)?.size();
    let size_usize = usize::try_from(size).unwrap_or(usize::MAX);
    let image = (kind != TreeEntryKind::Symlink)
        .then(|| media_type(path))
        .flatten();
    if image.is_some() {
        if size > MAX_IMAGE_PREVIEW as u64 {
            return Ok(wrap(size_usize, TreeFileContent::Binary));
        }
    } else if size > MAX_RENDER_BYTES && !force && kind != TreeEntryKind::Symlink {
        return Ok(wrap(
            size_usize,
            TreeFileContent::TooLarge {
                #[allow(clippy::cast_precision_loss)]
                limit: MAX_RENDER_BYTES as f64,
            },
        ));
    }
    let data = entry.object().map_err(read_err)?.detach().data;
    if kind == TreeEntryKind::Symlink {
        let target = String::from_utf8_lossy(&data).into_owned();
        return Ok(wrap(data.len(), TreeFileContent::Symlink { target }));
    }
    if let Some(object) = parse_pointer(&data) {
        return Ok(wrap(data.len(), TreeFileContent::Lfs { object }));
    }
    if let Some(media) = image
        && !data.is_empty()
    {
        return Ok(wrap(
            data.len(),
            data_url(media, &data).map_or(TreeFileContent::Binary, |url| TreeFileContent::Image {
                url,
            }),
        ));
    }
    if is_binary(&data) {
        return Ok(wrap(data.len(), TreeFileContent::Binary));
    }
    let (text, encoding) = decode(&data);
    Ok(wrap(
        data.len(),
        TreeFileContent::Text {
            text: text.into_owned(),
            encoding,
        },
    ))
}
