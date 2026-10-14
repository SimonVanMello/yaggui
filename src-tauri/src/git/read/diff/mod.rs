//! Changed files and file diffs of a commit range, the index or the working tree, through
//! `gix` (reads only). Blobs go through the gix diff pipeline, so `.gitattributes`
//! (`binary`, `-diff`, eol conversion) behave as in `git diff`.

pub mod text;
pub mod types;

use std::path::{Component, Path, PathBuf};

use gix::ObjectId;
use gix::bstr::{BStr, BString, ByteSlice};
use gix::diff::blob::pipeline::{Mode, WorktreeRoots};
use gix::diff::blob::platform::prepare_diff::Operation;
use gix::diff::blob::platform::resource::Data;
use gix::diff::blob::{Algorithm, Platform, ResourceKind};
use gix::object::tree::EntryKind;

use crate::git::errors::{BackendError, YagguiError};
use crate::git::read::lfs::{self, LfsMatcher, LfsObject};
use crate::git::read::state::DirtyState;
use text::{MAX_RENDER_BYTES, MAX_RENDER_LINES};
use types::{
    ChangedFile, ChangedFiles, DiffContent, DiffOptions, DiffTarget, FileDiff, FileMode, FileStatus,
};

/// Line stats are skipped for larger change sets: they need every blob.
pub const STATS_MAX_FILES: usize = 2_000;

fn gix<E>(context: &'static str) -> impl FnOnce(E) -> YagguiError
where
    E: std::error::Error + Send + Sync + 'static,
{
    move |err| BackendError::gix(context, err).into()
}

fn exn<E>(context: &'static str) -> impl FnOnce(gix::error::Exn<E>) -> YagguiError
where
    E: std::error::Error + Send + Sync + 'static,
{
    move |err| BackendError::gix(context, err.into_error()).into()
}

/// One version of a path. A null `id` means "read it from the working tree".
#[derive(Debug, Clone)]
struct Side {
    id: ObjectId,
    kind: EntryKind,
}

impl Side {
    fn mode(&self) -> FileMode {
        match self.kind {
            EntryKind::BlobExecutable => FileMode::Executable,
            EntryKind::Link => FileMode::Symlink,
            EntryKind::Commit => FileMode::Submodule,
            EntryKind::Blob | EntryKind::Tree => FileMode::Regular,
        }
    }

    fn known_id(&self) -> Option<String> {
        (!self.id.is_null()).then(|| self.id.to_string())
    }
}

#[derive(Debug, Clone)]
struct Change {
    path: BString,
    old_path: Option<BString>,
    status: FileStatus,
    old: Option<Side>,
    new: Option<Side>,
}

fn invalid(en: String, fr: String) -> YagguiError {
    YagguiError::invalid_argument(en, fr)
}

/// Rename and copy detection, like `git diff -M -C`.
fn rewrites() -> gix::diff::Rewrites {
    gix::diff::Rewrites {
        copies: Some(gix::diff::rewrites::Copies::default()),
        ..Default::default()
    }
}

fn index_kind(mode: gix::index::entry::Mode) -> EntryKind {
    mode.to_tree_entry_mode()
        .map_or(EntryKind::Blob, |mode| mode.kind())
}

pub(crate) fn validate_path(path: &str) -> Result<(), YagguiError> {
    let p = Path::new(path);
    let traversal = p
        .components()
        .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir));
    // `.`, `dir/` or `a/./b` name no file; a NUL would split the path in a pathspec file.
    let not_a_file =
        path.split('/').any(|part| part.is_empty() || part == ".") || path.contains('\0');
    if path.trim().is_empty() || p.is_absolute() || traversal || not_a_file {
        return Err(invalid(
            format!("Expected a path relative to the repository, got \"{path}\"."),
            format!("Chemin relatif au dépôt attendu, reçu « {path} »."),
        ));
    }
    Ok(())
}

fn no_changes(path: &str) -> YagguiError {
    invalid(
        format!("\"{path}\" has no changes here."),
        format!("« {path} » n'a pas de modification ici."),
    )
}

fn validate_rev(rev: &str) -> Result<(), YagguiError> {
    if rev.trim().is_empty() || rev.starts_with('-') {
        return Err(invalid(
            format!("Invalid revision \"{rev}\"."),
            format!("Révision invalide « {rev} »."),
        ));
    }
    Ok(())
}

fn unknown_rev(rev: &str, err: impl std::fmt::Display) -> YagguiError {
    invalid(
        format!("Unknown revision \"{rev}\"."),
        format!("Révision inconnue « {rev} »."),
    )
    .with_detail(err.to_string())
}

/// The trees compared by `DiffTarget::Commits`.
fn commit_trees<'r>(
    repo: &'r gix::Repository,
    from: Option<&str>,
    to: &str,
) -> Result<(gix::Tree<'r>, gix::Tree<'r>), YagguiError> {
    let commit = |rev: &str| -> Result<gix::Commit<'r>, YagguiError> {
        validate_rev(rev)?;
        repo.rev_parse_single(rev)
            .map_err(|e| unknown_rev(rev, e))?
            .object()
            .map_err(gix("read object"))?
            .peel_to_commit()
            .map_err(|e| unknown_rev(rev, e))
    };
    let to_commit = commit(to)?;
    let new_tree = to_commit.tree().map_err(gix("read tree"))?;
    let old_tree = match from {
        Some(from) => commit(from)?.tree().map_err(gix("read tree"))?,
        None => match to_commit.parent_ids().next() {
            Some(parent) => parent
                .object()
                .map_err(gix("read parent"))?
                .peel_to_commit()
                .map_err(gix("read parent"))?
                .tree()
                .map_err(gix("read tree"))?,
            None => repo.empty_tree(),
        },
    };
    Ok((old_tree, new_tree))
}

fn head_tree(repo: &gix::Repository) -> Result<gix::Tree<'_>, YagguiError> {
    match repo.head_commit() {
        Ok(commit) => commit.tree().map_err(gix("read HEAD tree")),
        // Unborn branch: everything in the index is new.
        Err(_) if repo.head().map_err(gix("read HEAD"))?.is_unborn() => Ok(repo.empty_tree()),
        Err(err) => Err(BackendError::gix("read HEAD", err).into()),
    }
}

fn worktree_root(repo: &gix::Repository) -> Result<PathBuf, YagguiError> {
    repo.workdir().map(Path::to_path_buf).ok_or_else(|| {
        invalid(
            "This repository has no working tree.".into(),
            "Ce dépôt n'a pas d'arbre de travail.".into(),
        )
    })
}

/// Whether a folder on the way to `path` is a symlink: reading through it could leave the
/// working tree (`link/secret` with `link -> /etc`). Git never tracks such paths.
pub(crate) fn has_symlink_parent(root: &Path, path: &BStr) -> bool {
    let relative = fs_path(path);
    let mut current = root.to_path_buf();
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        if components.peek().is_none() {
            break;
        }
        current.push(component);
        if std::fs::symlink_metadata(&current).is_ok_and(|m| m.file_type().is_symlink()) {
            return true;
        }
    }
    false
}

/// Entry type of a working tree file, `None` if it does not exist or is not safely inside
/// the working tree.
fn worktree_kind(
    root: &Path,
    path: &BStr,
    index_kind: Option<EntryKind>,
    exec_bit: bool,
) -> Option<EntryKind> {
    if has_symlink_parent(root, path) {
        return None;
    }
    let full = root.join(fs_path(path));
    let meta = std::fs::symlink_metadata(&full).ok()?;
    if meta.file_type().is_symlink() {
        return Some(EntryKind::Link);
    }
    if meta.is_dir() {
        return (index_kind == Some(EntryKind::Commit) || full.join(".git").exists())
            .then_some(EntryKind::Commit);
    }
    // Without a meaningful executable bit (`core.fileMode` false: Windows, FAT or NTFS
    // mounts), keep what the index says, like Git.
    let index_mode = match index_kind {
        Some(EntryKind::BlobExecutable) => EntryKind::BlobExecutable,
        _ => EntryKind::Blob,
    };
    #[cfg(unix)]
    if exec_bit {
        use std::os::unix::fs::PermissionsExt;
        return Some(if meta.permissions().mode() & 0o111 != 0 {
            EntryKind::BlobExecutable
        } else {
            EntryKind::Blob
        });
    }
    #[cfg(not(unix))]
    let _ = exec_bit;
    Some(index_mode)
}

/// `core.fileMode`: whether the executable bit on disk is meaningful (Git's default: true,
/// `git init` writes false on Windows).
fn exec_bit(repo: &gix::Repository) -> bool {
    repo.config_snapshot()
        .boolean("core.fileMode")
        .unwrap_or(cfg!(unix))
}

/// HEAD commit of a checked-out submodule.
fn submodule_head(root: &Path, path: &BStr) -> Option<ObjectId> {
    let repo = gix::open(root.join(fs_path(path))).ok()?;
    repo.head_id().ok().map(|id| id.detach())
}

fn modified_status(old: &Side, new: &Side) -> FileStatus {
    let file = |k: EntryKind| matches!(k, EntryKind::Blob | EntryKind::BlobExecutable);
    if old.kind == new.kind || (file(old.kind) && file(new.kind)) {
        FileStatus::Modified
    } else {
        FileStatus::TypeChanged
    }
}

// ---- Change listing -------------------------------------------------------------------

fn commit_changes(
    repo: &gix::Repository,
    from: Option<&str>,
    to: &str,
) -> Result<Vec<Change>, YagguiError> {
    use gix::object::tree::diff::ChangeDetached as C;

    let (old_tree, new_tree) = commit_trees(repo, from, to)?;
    let options = gix::diff::Options::default().with_rewrites(Some(rewrites()));
    let changes = repo
        .diff_tree_to_tree(&old_tree, &new_tree, options)
        .map_err(gix("diff trees"))?;
    let side = |id: ObjectId, mode: gix::object::tree::EntryMode| Side {
        id,
        kind: mode.kind(),
    };
    Ok(changes
        .into_iter()
        .filter(|c| !c.entry_mode().is_tree())
        .map(|c| match c {
            C::Addition {
                location,
                entry_mode,
                id,
                ..
            } => Change {
                path: location,
                old_path: None,
                status: FileStatus::Added,
                old: None,
                new: Some(side(id, entry_mode)),
            },
            C::Deletion {
                location,
                entry_mode,
                id,
                ..
            } => Change {
                path: location,
                old_path: None,
                status: FileStatus::Deleted,
                old: Some(side(id, entry_mode)),
                new: None,
            },
            C::Modification {
                location,
                previous_entry_mode,
                previous_id,
                entry_mode,
                id,
            } => {
                let old = side(previous_id, previous_entry_mode);
                let new = side(id, entry_mode);
                Change {
                    path: location,
                    old_path: None,
                    status: modified_status(&old, &new),
                    old: Some(old),
                    new: Some(new),
                }
            }
            C::Rewrite {
                source_location,
                source_entry_mode,
                source_id,
                entry_mode,
                id,
                location,
                copy,
                ..
            } => Change {
                path: location,
                old_path: Some(source_location),
                status: if copy {
                    FileStatus::Copied
                } else {
                    FileStatus::Renamed
                },
                old: Some(side(source_id, source_entry_mode)),
                new: Some(side(id, entry_mode)),
            },
        })
        .collect())
}

fn staged_changes(repo: &gix::Repository) -> Result<Vec<Change>, YagguiError> {
    use gix::diff::index::ChangeRef as C;

    let tree = head_tree(repo)?;
    let index = repo.index_or_empty().map_err(gix("read index"))?;
    let mut out = Vec::new();
    let side = |id: &gix::oid, mode: gix::index::entry::Mode| Side {
        id: id.to_owned(),
        kind: index_kind(mode),
    };
    repo.tree_index_status(
        &tree.id,
        &index,
        None,
        gix::status::tree_index::TrackRenames::Given(rewrites()),
        |change, _, _| {
            out.push(match change {
                C::Addition {
                    location,
                    entry_mode,
                    id,
                    ..
                } => Change {
                    path: location.into_owned(),
                    old_path: None,
                    status: FileStatus::Added,
                    old: None,
                    new: Some(side(&id, entry_mode)),
                },
                C::Deletion {
                    location,
                    entry_mode,
                    id,
                    ..
                } => Change {
                    path: location.into_owned(),
                    old_path: None,
                    status: FileStatus::Deleted,
                    old: Some(side(&id, entry_mode)),
                    new: None,
                },
                C::Modification {
                    location,
                    previous_entry_mode,
                    previous_id,
                    entry_mode,
                    id,
                    ..
                } => {
                    let old = side(&previous_id, previous_entry_mode);
                    let new = side(&id, entry_mode);
                    Change {
                        path: location.into_owned(),
                        old_path: None,
                        status: modified_status(&old, &new),
                        old: Some(old),
                        new: Some(new),
                    }
                }
                C::Rewrite {
                    source_location,
                    source_entry_mode,
                    source_id,
                    location,
                    entry_mode,
                    id,
                    copy,
                    ..
                } => Change {
                    path: location.into_owned(),
                    old_path: Some(source_location.into_owned()),
                    status: if copy {
                        FileStatus::Copied
                    } else {
                        FileStatus::Renamed
                    },
                    old: Some(side(&source_id, source_entry_mode)),
                    new: Some(side(&id, entry_mode)),
                },
            });
            Ok(gix::diff::index::Action::Continue(()))
        },
    )
    .map_err(gix("compare HEAD and index"))?;
    // Unmerged paths belong to the conflict view, not to the staged list.
    out.retain(|c| {
        index
            .entry_by_path(c.path.as_bstr())
            .is_none_or(|e| e.stage() == gix::index::entry::Stage::Unconflicted)
    });
    Ok(out)
}

fn unstaged_changes(repo: &gix::Repository) -> Result<Vec<Change>, YagguiError> {
    use gix::status::index_worktree::Item;
    use gix::status::plumbing::index_as_worktree::{Change as W, EntryStatus};

    let root = worktree_root(repo)?;
    let exec = exec_bit(repo);
    let iter = repo
        .status(gix::progress::Discard)
        .map_err(gix("status"))?
        .untracked_files(gix::status::UntrackedFiles::Files)
        .index_worktree_rewrites(None)
        .index_worktree_submodules(gix::status::Submodule::Given {
            ignore: gix::submodule::config::Ignore::Dirty,
            check_dirty: false,
        })
        .into_index_worktree_iter(Vec::<BString>::new())
        .map_err(gix("status"))?;
    let mut out: Vec<Change> = Vec::new();
    for item in iter {
        let item = item.map_err(gix("status"))?;
        match item {
            Item::Modification {
                entry,
                rela_path,
                status,
                ..
            } => {
                let old = Side {
                    id: entry.id,
                    kind: index_kind(entry.mode),
                };
                let worktree = |fallback: EntryKind| Side {
                    id: ObjectId::null(repo.object_hash()),
                    kind: worktree_kind(&root, rela_path.as_bstr(), Some(old.kind), exec)
                        .unwrap_or(fallback),
                };
                let (status, old, new) = match status {
                    EntryStatus::Conflict { .. } => (FileStatus::Conflicted, None, None),
                    EntryStatus::IntentToAdd => {
                        let new = worktree(old.kind);
                        (FileStatus::Added, None, Some(new))
                    }
                    EntryStatus::NeedsUpdate(_) => continue,
                    EntryStatus::Change(W::Removed) => (FileStatus::Deleted, Some(old), None),
                    EntryStatus::Change(W::SubmoduleModification(sub)) => {
                        // Only a moved submodule HEAD is a change of the superproject.
                        let head = sub.checked_out_head_id;
                        if head.is_none() || head == sub.index_id {
                            continue;
                        }
                        let new = Side {
                            id: head.unwrap_or_else(|| ObjectId::null(repo.object_hash())),
                            kind: EntryKind::Commit,
                        };
                        (FileStatus::Modified, Some(old), Some(new))
                    }
                    EntryStatus::Change(W::Type { .. }) => {
                        let new = worktree(old.kind);
                        (FileStatus::TypeChanged, Some(old), Some(new))
                    }
                    EntryStatus::Change(W::Modification { .. }) => {
                        let new = worktree(old.kind);
                        (modified_status(&old, &new), Some(old), Some(new))
                    }
                };
                // A conflict has one entry per stage: list the path once.
                if status == FileStatus::Conflicted
                    && out.last().is_some_and(|c| c.path == rela_path)
                {
                    continue;
                }
                out.push(Change {
                    path: rela_path,
                    old_path: None,
                    status,
                    old,
                    new,
                });
            }
            Item::DirectoryContents { entry, .. } => {
                if entry.status != gix::dir::entry::Status::Untracked {
                    continue;
                }
                let Some(kind) = worktree_kind(&root, entry.rela_path.as_bstr(), None, exec) else {
                    continue;
                };
                // Untracked nested repositories are not files to diff.
                if kind == EntryKind::Commit {
                    continue;
                }
                out.push(Change {
                    path: entry.rela_path,
                    old_path: None,
                    status: FileStatus::Untracked,
                    old: None,
                    new: Some(Side {
                        id: ObjectId::null(repo.object_hash()),
                        kind,
                    }),
                });
            }
            Item::Rewrite { .. } => {}
        }
    }
    Ok(out)
}

/// Whether `path` is an untracked (not ignored) file, asking the status for that path only.
fn is_untracked(repo: &gix::Repository, path: &BStr) -> Result<bool, YagguiError> {
    use gix::status::index_worktree::Item;

    let mut pattern = BString::from(":(literal)");
    pattern.extend_from_slice(path);
    let iter = repo
        .status(gix::progress::Discard)
        .map_err(gix("status"))?
        .untracked_files(gix::status::UntrackedFiles::Files)
        .index_worktree_rewrites(None)
        .index_worktree_submodules(None)
        .into_index_worktree_iter(vec![pattern])
        .map_err(gix("status"))?;
    for item in iter {
        if let Item::DirectoryContents { entry, .. } = item.map_err(gix("status"))?
            && entry.status == gix::dir::entry::Status::Untracked
            && entry.rela_path == path
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn changes(repo: &gix::Repository, target: &DiffTarget) -> Result<Vec<Change>, YagguiError> {
    match target {
        DiffTarget::Commits { from, to } => commit_changes(repo, from.as_deref(), to),
        DiffTarget::Staged => staged_changes(repo),
        DiffTarget::Unstaged => unstaged_changes(repo),
    }
}

// ---- Blob access -----------------------------------------------------------------------

fn platform(repo: &gix::Repository, target: &DiffTarget) -> Result<Platform, YagguiError> {
    let roots = match target {
        DiffTarget::Unstaged => WorktreeRoots {
            old_root: None,
            new_root: Some(worktree_root(repo)?),
        },
        DiffTarget::Commits { .. } | DiffTarget::Staged => WorktreeRoots::default(),
    };
    repo.diff_resource_cache(Mode::ToGit, roots)
        .map_err(gix("prepare the diff"))
}

/// The two sides loaded through the pipeline, ready to diff.
enum Loaded<'a> {
    Text {
        old: &'a [u8],
        new: &'a [u8],
        algorithm: Algorithm,
    },
    Binary {
        old_size: Option<f64>,
        new_size: Option<f64>,
    },
}

#[allow(clippy::cast_precision_loss)] // Sizes are shown rounded; f64 is exact up to 2^53.
fn size(data: &Data<'_>) -> Option<f64> {
    match data {
        Data::Missing => None,
        Data::Buffer { buf, .. } => Some(buf.len() as f64),
        Data::Binary { size } => Some(*size as f64),
    }
}

fn load<'p>(
    platform: &'p mut Platform,
    repo: &gix::Repository,
    old: Option<(&Side, &BStr)>,
    new: Option<(&Side, &BStr)>,
) -> Result<Loaded<'p>, YagguiError> {
    let null = ObjectId::null(repo.object_hash());
    // An absent side is a null id of the other side's kind, read from the object database.
    let fallback = old.or(new).map_or(EntryKind::Blob, |(s, _)| s.kind);
    for (side, kind) in [
        (old, ResourceKind::OldOrSource),
        (new, ResourceKind::NewOrDestination),
    ] {
        let (id, entry_kind, path) = match side {
            Some((s, path)) => (s.id, s.kind, path),
            None => (
                null,
                fallback,
                old.or(new).map_or(BStr::new(""), |(_, p)| p),
            ),
        };
        platform
            .set_resource(id, entry_kind, path, kind, &repo.objects)
            .map_err(exn("load a file version"))?;
    }
    let outcome = platform.prepare_diff().map_err(exn("prepare the diff"))?;
    let (old_data, new_data) = (outcome.old.data, outcome.new.data);
    Ok(match outcome.operation {
        Operation::SourceOrDestinationIsBinary => Loaded::Binary {
            old_size: size(&old_data),
            new_size: size(&new_data),
        },
        Operation::InternalDiff { algorithm } => Loaded::Text {
            old: old_data.as_slice().unwrap_or_default(),
            new: new_data.as_slice().unwrap_or_default(),
            algorithm,
        },
        // External diff drivers are not run: diff the converted content ourselves.
        Operation::ExternalCommand { .. } => Loaded::Text {
            old: old_data.as_slice().unwrap_or_default(),
            new: new_data.as_slice().unwrap_or_default(),
            algorithm: Algorithm::default(),
        },
    })
}

/// Size of one side without loading it: the object header, or the file metadata (a symlink is
/// its own size). `None` when unknown.
fn stored_size(
    repo: &gix::Repository,
    side: &Side,
    root: Option<&Path>,
    path: &BStr,
) -> Option<u64> {
    if !side.id.is_null() {
        return repo.find_header(side.id).ok().map(|header| header.size());
    }
    let full = root?.join(fs_path(path));
    std::fs::symlink_metadata(full).ok().map(|meta| meta.len())
}

#[allow(clippy::cast_precision_loss)] // Sizes are shown rounded; f64 is exact up to 2^53.
fn as_f64(size: Option<u64>) -> Option<f64> {
    size.map(|s| s as f64)
}

fn is_submodule(side: Option<&Side>) -> bool {
    side.is_some_and(|s| s.kind == EntryKind::Commit)
}

/// Repository-relative path as a filesystem path.
fn fs_path(path: &BStr) -> PathBuf {
    gix::path::from_bstr(path).map_or_else(
        |_| PathBuf::from(path.to_str_lossy().as_ref()),
        std::borrow::Cow::into_owned,
    )
}

fn to_string(path: &BStr) -> String {
    path.to_str_lossy().into_owned()
}

// ---- Public API ------------------------------------------------------------------------

/// Changes of the working tree against the index and of the index against HEAD: what the
/// repo state (dirty counts) and the staged / unstaged lists show, read in one go.
#[derive(Debug, Clone)]
pub struct WorktreeStatus {
    unstaged: Vec<Change>,
    staged: Vec<Change>,
}

impl WorktreeStatus {
    /// Both comparisons are independent: they run side by side.
    pub fn read(repo: &gix::Repository) -> Result<Self, YagguiError> {
        let shared = repo.clone().into_sync();
        std::thread::scope(|scope| {
            let staged = scope.spawn(|| staged_changes(&shared.to_thread_local()));
            let unstaged = unstaged_changes(repo);
            let staged = staged.join().map_err(|_| {
                YagguiError::from(BackendError::Invariant(
                    "the staged status thread panicked".into(),
                ))
            })?;
            Ok(Self {
                unstaged: unstaged?,
                staged: staged?,
            })
        })
    }

    /// Changed paths by kind: as many as the staged and unstaged lists show.
    pub fn dirty(&self) -> DirtyState {
        let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
        let unstaged =
            |status: FileStatus| !matches!(status, FileStatus::Untracked | FileStatus::Conflicted);
        DirtyState {
            staged: count(self.staged.len()),
            unstaged: count(self.unstaged.iter().filter(|c| unstaged(c.status)).count()),
            untracked: count(
                self.unstaged
                    .iter()
                    .filter(|c| c.status == FileStatus::Untracked)
                    .count(),
            ),
            conflicted: count(
                self.unstaged
                    .iter()
                    .filter(|c| c.status == FileStatus::Conflicted)
                    .count(),
            ),
        }
    }
}

/// Changed paths of `target`, with status, rename similarity and line stats.
pub fn changed_files(
    repo: &gix::Repository,
    target: &DiffTarget,
) -> Result<ChangedFiles, YagguiError> {
    with_stats(repo, target, changes(repo, target)?)
}

/// Like [`changed_files`], taking the index and working tree changes from `status`.
pub fn changed_files_in(
    repo: &gix::Repository,
    target: &DiffTarget,
    status: &WorktreeStatus,
) -> Result<ChangedFiles, YagguiError> {
    let changes = match target {
        DiffTarget::Staged => status.staged.clone(),
        DiffTarget::Unstaged => status.unstaged.clone(),
        DiffTarget::Commits { .. } => changes(repo, target)?,
    };
    with_stats(repo, target, changes)
}

fn with_stats(
    repo: &gix::Repository,
    target: &DiffTarget,
    mut changes: Vec<Change>,
) -> Result<ChangedFiles, YagguiError> {
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    let stats_skipped = changes.len() > STATS_MAX_FILES;
    let mut platform = platform(repo, target)?;
    let root = match target {
        DiffTarget::Unstaged => Some(worktree_root(repo)?),
        _ => None,
    };

    let mut lfs_matcher = LfsMatcher::new(repo)?;
    let mut lfs = Vec::new();
    let files = changes
        .into_iter()
        .map(|change| {
            let mut file = ChangedFile {
                path: to_string(change.path.as_bstr()),
                old_path: change.old_path.as_ref().map(|p| to_string(p.as_bstr())),
                status: change.status,
                similarity: None,
                additions: None,
                deletions: None,
                binary: false,
                old_mode: change.old.as_ref().map(Side::mode),
                new_mode: change.new.as_ref().map(Side::mode),
            };
            let rewrite = matches!(change.status, FileStatus::Renamed | FileStatus::Copied);
            let identical = matches!((&change.old, &change.new), (Some(o), Some(n)) if o.id == n.id && !o.id.is_null());
            if rewrite && identical {
                file.similarity = Some(100);
            }
            let skip = stats_skipped
                || change.status == FileStatus::Conflicted
                || is_submodule(change.old.as_ref())
                || is_submodule(change.new.as_ref());
            if skip {
                return file;
            }
            let old_path = change.old_path.as_ref().unwrap_or(&change.path);
            // Pointer stats mean nothing, and the clean filter would read the whole content.
            if let Some(matcher) = lfs_matcher.as_mut()
                && (matcher.is_lfs(change.path.as_bstr()) || matcher.is_lfs(old_path.as_bstr()))
            {
                lfs.push(file.path.clone());
                return file;
            }
            // Big files are never loaded for stats: the diff view guards them the same way.
            let too_big = [
                change.old.as_ref().map(|s| (s, old_path.as_bstr())),
                change.new.as_ref().map(|s| (s, change.path.as_bstr())),
            ]
            .into_iter()
            .flatten()
            .any(|(side, path)| {
                stored_size(repo, side, root.as_deref(), path).is_some_and(|size| size > MAX_RENDER_BYTES)
            });
            if too_big {
                return file;
            }
            let loaded = load(
                &mut platform,
                repo,
                change.old.as_ref().map(|s| (s, old_path.as_bstr())),
                change.new.as_ref().map(|s| (s, change.path.as_bstr())),
            );
            match loaded {
                Ok(Loaded::Binary { .. }) => file.binary = true,
                Ok(Loaded::Text {
                    old,
                    new,
                    algorithm,
                }) => {
                    let stats = text::line_stats(old, new, algorithm);
                    file.additions = Some(stats.additions);
                    file.deletions = Some(stats.deletions);
                    if rewrite && file.similarity.is_none() {
                        file.similarity = Some(stats.similarity());
                    }
                }
                Err(err) => {
                    tracing::warn!(path = %file.path, error = %err, "no line stats");
                }
            }
            platform.clear_resource_cache_keep_allocation();
            file
        })
        .collect();
    Ok(ChangedFiles {
        files,
        stats_skipped,
        lfs,
    })
}

/// The two versions of `path` (and `old_path` for a rename) in `target`.
fn sides(
    repo: &gix::Repository,
    target: &DiffTarget,
    path: &BStr,
    old_path: &BStr,
) -> Result<(Option<Side>, Option<Side>, bool), YagguiError> {
    let tree_side = |tree: &gix::Tree<'_>, path: &BStr| -> Result<Option<Side>, YagguiError> {
        Ok(tree
            .lookup_entry_by_path(fs_path(path))
            .map_err(gix("read tree"))?
            .filter(|e| !e.mode().is_tree())
            .map(|e| Side {
                id: e.object_id(),
                kind: e.mode().kind(),
            }))
    };
    let index_side = |index: &gix::index::State, path: &BStr| -> (Option<Side>, bool) {
        match index.entry_by_path(path) {
            Some(e) if e.stage() != gix::index::entry::Stage::Unconflicted => (None, true),
            Some(e) => (
                Some(Side {
                    id: e.id,
                    kind: index_kind(e.mode),
                }),
                false,
            ),
            None => (None, false),
        }
    };
    match target {
        DiffTarget::Commits { from, to } => {
            let (old_tree, new_tree) = commit_trees(repo, from.as_deref(), to)?;
            Ok((
                tree_side(&old_tree, old_path)?,
                tree_side(&new_tree, path)?,
                false,
            ))
        }
        DiffTarget::Staged => {
            let index = repo.index_or_empty().map_err(gix("read index"))?;
            let (new, conflicted) = index_side(&index, path);
            Ok((tree_side(&head_tree(repo)?, old_path)?, new, conflicted))
        }
        DiffTarget::Unstaged => {
            let root = worktree_root(repo)?;
            let index = repo.index_or_empty().map_err(gix("read index"))?;
            // Only paths Git knows about are read from disk: tracked ones, or untracked files
            // the status reports (never ignored files, never through a symlinked folder).
            let tracked =
                index.entry_by_path(path).is_some() || index.entry_by_path(old_path).is_some();
            if has_symlink_parent(&root, path) || (!tracked && !is_untracked(repo, path)?) {
                return Err(no_changes(&path.to_str_lossy()));
            }
            let (old, conflicted) = index_side(&index, old_path);
            let exec = exec_bit(repo);
            let new =
                worktree_kind(&root, path, old.as_ref().map(|s| s.kind), exec).map(|kind| Side {
                    id: if kind == EntryKind::Commit {
                        submodule_head(&root, path)
                            .unwrap_or_else(|| ObjectId::null(repo.object_hash()))
                    } else {
                        ObjectId::null(repo.object_hash())
                    },
                    kind,
                });
            Ok((old, new, conflicted))
        }
    }
}

/// Diff of one path of `target`. `old_path` is the source of a rename or copy.
pub fn file_diff(
    repo: &gix::Repository,
    target: &DiffTarget,
    path: &str,
    old_path: Option<&str>,
    options: &DiffOptions,
) -> Result<FileDiff, YagguiError> {
    validate_path(path)?;
    if let Some(old_path) = old_path {
        validate_path(old_path)?;
    }
    let new_path = BStr::new(path.as_bytes());
    let source_path = BStr::new(old_path.unwrap_or(path).as_bytes());
    let (old, new, conflicted) = sides(repo, target, new_path, source_path)?;

    let mut diff = FileDiff {
        path: path.to_owned(),
        old_path: old_path.map(str::to_owned),
        old_id: old.as_ref().and_then(Side::known_id),
        new_id: new.as_ref().and_then(Side::known_id),
        old_mode: old.as_ref().map(Side::mode),
        new_mode: new.as_ref().map(Side::mode),
        content: DiffContent::Conflict,
    };
    if conflicted {
        return Ok(diff);
    }
    if old.is_none() && new.is_none() {
        return Err(no_changes(path));
    }
    if is_submodule(old.as_ref()) || is_submodule(new.as_ref()) {
        let commit = |s: Option<&Side>| {
            s.filter(|s| s.kind == EntryKind::Commit)
                .and_then(Side::known_id)
        };
        diff.content = DiffContent::Submodule {
            old_commit: commit(old.as_ref()),
            new_commit: commit(new.as_ref()),
        };
        return Ok(diff);
    }

    let root = match target {
        DiffTarget::Unstaged => Some(worktree_root(repo)?),
        _ => None,
    };
    if let Some(content) = lfs_content(
        repo,
        root.as_deref(),
        old.as_ref().map(|s| (s, source_path)),
        new.as_ref().map(|s| (s, new_path)),
    )? {
        diff.content = content;
        return Ok(diff);
    }

    // Size guard before anything is loaded: a huge file costs neither memory nor CPU unless
    // the user asks for it.
    if !options.force {
        let old_size = old
            .as_ref()
            .and_then(|s| stored_size(repo, s, root.as_deref(), source_path));
        let new_size = new
            .as_ref()
            .and_then(|s| stored_size(repo, s, root.as_deref(), new_path));
        if old_size
            .max(new_size)
            .is_some_and(|size| size > MAX_RENDER_BYTES)
        {
            diff.content = DiffContent::TooLarge {
                old_size: as_f64(old_size),
                new_size: as_f64(new_size),
                lines: None,
            };
            return Ok(diff);
        }
    }

    let mut platform = platform(repo, target)?;
    let loaded = load(
        &mut platform,
        repo,
        old.as_ref().map(|s| (s, source_path)),
        new.as_ref().map(|s| (s, new_path)),
    )?;
    diff.content = match loaded {
        Loaded::Binary { old_size, new_size } => DiffContent::Binary { old_size, new_size },
        Loaded::Text {
            old: old_bytes,
            new: new_bytes,
            algorithm,
        } => {
            if new.as_ref().is_some_and(|s| s.id.is_null()) {
                diff.new_id = Some(blob_id(repo, new_bytes)?.to_string());
            }
            let text = text::text_diff(old_bytes, new_bytes, algorithm, options);
            let lines = text::rendered_lines(&text);
            if lines > MAX_RENDER_LINES && !options.force {
                #[allow(clippy::cast_precision_loss)]
                let size = |bytes: &[u8], present: bool| present.then_some(bytes.len() as f64);
                DiffContent::TooLarge {
                    old_size: size(old_bytes, old.is_some()),
                    new_size: size(new_bytes, new.is_some()),
                    lines: Some(lines),
                }
            } else {
                DiffContent::Text(text)
            }
        }
    };
    Ok(diff)
}

/// The LFS view of a file routed to LFS by the attributes, or whose stored version is a
/// pointer (a commit made before the attributes changed). `None`: diff it normally.
fn lfs_content(
    repo: &gix::Repository,
    root: Option<&Path>,
    old: Option<(&Side, &BStr)>,
    new: Option<(&Side, &BStr)>,
) -> Result<Option<DiffContent>, YagguiError> {
    let sides = [old, new];
    let tracked = match LfsMatcher::new(repo)? {
        Some(mut matcher) => sides.iter().flatten().any(|(_, path)| matcher.is_lfs(path)),
        None => false,
    };
    let objects = sides.map(|side| side.map(|(side, path)| lfs_object(repo, side, root, path)));
    let has_pointer = objects
        .iter()
        .flatten()
        .any(|object| object.as_ref().is_some_and(|o| o.oid.is_some()));
    if !tracked && !has_pointer {
        return Ok(None);
    }
    let [old, new] = objects.map(Option::flatten);
    Ok(Some(DiffContent::Lfs { old, new }))
}

/// One side of an LFS file: the parsed pointer, or the size of the content when the side is
/// not a pointer (working tree file, content committed before LFS). `None` when unreadable.
fn lfs_object(
    repo: &gix::Repository,
    side: &Side,
    root: Option<&Path>,
    path: &BStr,
) -> Option<LfsObject> {
    if side.kind != EntryKind::Blob && side.kind != EntryKind::BlobExecutable {
        return None;
    }
    let size = stored_size(repo, side, root, path)?;
    let pointer = if size > lfs::POINTER_MAX_BYTES {
        None
    } else if side.id.is_null() {
        std::fs::read(root?.join(fs_path(path)))
            .ok()
            .and_then(|data| lfs::parse_pointer(&data))
    } else {
        repo.find_blob(side.id)
            .ok()
            .and_then(|blob| lfs::parse_pointer(&blob.data))
    };
    #[allow(clippy::cast_precision_loss)] // Shown rounded; exact up to 2^53 bytes.
    Some(pointer.unwrap_or(LfsObject {
        oid: None,
        size: size as f64,
    }))
}

/// Id of `data` as a blob (`git hash-object`, once converted to its Git form).
fn blob_id(repo: &gix::Repository, data: &[u8]) -> Result<ObjectId, YagguiError> {
    gix::objs::compute_hash(repo.object_hash(), gix::object::Kind::Blob, data)
        .map_err(gix("hash the working tree file"))
}

/// One side of a file, as a hunk operation needs it.
#[derive(Debug, Clone)]
pub struct SourceSide {
    /// Blob id (hash of the converted content for a working tree file).
    pub id: String,
    pub mode: FileMode,
    /// Content in its Git form, as diffed.
    pub content: Vec<u8>,
}

/// Both sides of a text file diff and its hunks, for building a patch from a selection.
#[derive(Debug, Clone)]
pub struct HunkSource {
    pub old: Option<SourceSide>,
    pub new: Option<SourceSide>,
    pub spans: Vec<text::HunkSpan>,
}

fn not_patchable(path: &str) -> YagguiError {
    invalid(
        format!("Lines of \"{path}\" cannot be selected: it is not a text file."),
        format!(
            "Les lignes de « {path} » ne peuvent pas être sélectionnées : ce n'est pas un fichier texte."
        ),
    )
}

/// The diff `file_diff` shows for `path` with `options`, as raw sides and hunk spans (same
/// hunk ids). Refused for conflicts, submodules, symlinks and binary files.
pub fn hunk_source(
    repo: &gix::Repository,
    target: &DiffTarget,
    path: &str,
    old_path: Option<&str>,
    options: &DiffOptions,
) -> Result<HunkSource, YagguiError> {
    validate_path(path)?;
    if let Some(old_path) = old_path {
        validate_path(old_path)?;
    }
    let new_path = BStr::new(path.as_bytes());
    let source_path = BStr::new(old_path.unwrap_or(path).as_bytes());
    let (old, new, conflicted) = sides(repo, target, new_path, source_path)?;
    if conflicted {
        return Err(YagguiError::unresolved_conflicts());
    }
    if old.is_none() && new.is_none() {
        return Err(no_changes(path));
    }
    let text_file = |s: &Option<Side>| {
        s.as_ref()
            .is_none_or(|s| matches!(s.kind, EntryKind::Blob | EntryKind::BlobExecutable))
    };
    if !text_file(&old) || !text_file(&new) {
        return Err(not_patchable(path));
    }
    let mut platform = platform(repo, target)?;
    let loaded = load(
        &mut platform,
        repo,
        old.as_ref().map(|s| (s, source_path)),
        new.as_ref().map(|s| (s, new_path)),
    )?;
    let Loaded::Text {
        old: old_bytes,
        new: new_bytes,
        algorithm,
    } = loaded
    else {
        return Err(not_patchable(path));
    };
    let source_side =
        |side: Option<&Side>, bytes: &[u8]| -> Result<Option<SourceSide>, YagguiError> {
            side.map(|s| {
                let id = if s.id.is_null() {
                    blob_id(repo, bytes)?
                } else {
                    s.id
                };
                Ok(SourceSide {
                    id: id.to_string(),
                    mode: s.mode(),
                    content: bytes.to_vec(),
                })
            })
            .transpose()
        };
    Ok(HunkSource {
        spans: text::hunk_spans(old_bytes, new_bytes, algorithm, options),
        old: source_side(old.as_ref(), old_bytes)?,
        new: source_side(new.as_ref(), new_bytes)?,
    })
}

/// A changed path of a target, without stats.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangedPath {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
}

/// Changed paths of `target`, cheaper than `changed_files` (no blob is loaded).
pub fn changed_paths(
    repo: &gix::Repository,
    target: &DiffTarget,
) -> Result<Vec<ChangedPath>, YagguiError> {
    Ok(changes(repo, target)?
        .into_iter()
        .map(|c| ChangedPath {
            path: to_string(c.path.as_bstr()),
            old_path: c.old_path.as_ref().map(|p| to_string(p.as_bstr())),
            status: c.status,
        })
        .collect())
}

/// One side of an image of `target` as a `data:` URL, for the image diff (F-085). `None`
/// when the path is not an image the webview shows, the side is absent, a submodule or a
/// symlink, or the image is larger than `image::MAX_IMAGE_PREVIEW`. The bytes are the stored
/// ones (no filter: images are not text).
pub fn image(
    repo: &gix::Repository,
    target: &DiffTarget,
    path: &str,
    old_path: Option<&str>,
    side: types::DiffSide,
) -> Result<Option<String>, YagguiError> {
    validate_path(path)?;
    if let Some(old_path) = old_path {
        validate_path(old_path)?;
    }
    let shown = match side {
        types::DiffSide::Old => old_path.unwrap_or(path),
        types::DiffSide::New => path,
    };
    let Some(media) = crate::git::read::image::media_type(shown) else {
        return Ok(None);
    };
    let new_path = BStr::new(path.as_bytes());
    let source_path = BStr::new(old_path.unwrap_or(path).as_bytes());
    let (old, new, _) = sides(repo, target, new_path, source_path)?;
    let chosen = match side {
        types::DiffSide::Old => old,
        types::DiffSide::New => new,
    };
    let Some(chosen) =
        chosen.filter(|s| matches!(s.kind, EntryKind::Blob | EntryKind::BlobExecutable))
    else {
        return Ok(None);
    };
    let too_large = |size: u64| {
        usize::try_from(size).map_or(true, |s| s > crate::git::read::image::MAX_IMAGE_PREVIEW)
    };
    let data = if chosen.id.is_null() {
        // Working tree side: `sides` already refused paths through a symlinked folder.
        let full = worktree_root(repo)?.join(fs_path(new_path));
        let meta = std::fs::symlink_metadata(&full)
            .map_err(|err| YagguiError::internal(format!("{}: {err}", full.display())))?;
        if !meta.is_file() || too_large(meta.len()) {
            return Ok(None);
        }
        std::fs::read(&full)
            .map_err(|err| YagguiError::internal(format!("{}: {err}", full.display())))?
    } else {
        if repo
            .find_header(chosen.id)
            .is_ok_and(|h| too_large(h.size()))
        {
            return Ok(None);
        }
        repo.find_object(chosen.id)
            .map_err(gix("read a blob"))?
            .detach()
            .data
    };
    Ok(crate::git::read::image::data_url(media, &data))
}
