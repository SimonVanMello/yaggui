//! Tree of a commit (M7-8, F-224): folder listings, file contents and saving a version.
//! Reads only, through `gix`: they do not go through the `OpQueue`.

use std::io::Write;
use std::path::Path;

use crate::git::errors::{BackendError, YagguiError};
use crate::git::read::tree::{self, TreeEntryKind, TreeFile, TreePage};

use super::RepoManager;

impl RepoManager {
    /// Entries `start .. start + limit` (≤ 500) of the folder `path` of `rev`; an empty
    /// `path` is the root. Errors: `revisionNotFound`, `invalidArgument` (not a folder).
    pub fn tree_list(
        &self,
        repo_id: u32,
        rev: &str,
        path: &str,
        start: u32,
        limit: u32,
    ) -> Result<TreePage, YagguiError> {
        let repo = self.session(repo_id)?.repo()?.to_thread_local();
        tree::list(&repo, rev, path, start, limit)
    }

    /// The file at `path` of `rev`, ready to display. `force` reads a text above the render
    /// limit.
    pub fn tree_file(
        &self,
        repo_id: u32,
        rev: &str,
        path: &str,
        force: bool,
    ) -> Result<TreeFile, YagguiError> {
        let repo = self.session(repo_id)?.repo()?.to_thread_local();
        tree::file(&repo, rev, path, force)
    }

    /// Writes the version of `path` stored in `rev` to `dest`. A symbolic link is saved as
    /// the text of its target, an LFS file as its pointer (what Git stores); a submodule has
    /// no content to save. An existing `dest` is only replaced when `overwrite` is set.
    pub fn tree_save(
        &self,
        repo_id: u32,
        rev: &str,
        path: &str,
        dest: &Path,
        overwrite: bool,
    ) -> Result<(), YagguiError> {
        let repo = self.session(repo_id)?.repo()?.to_thread_local();
        let blob = tree::read_blob(&repo, rev, path)?;
        if blob.kind == TreeEntryKind::Submodule {
            return Err(YagguiError::invalid_argument(
                format!("\"{path}\" is a submodule: it has no file content to save."),
                format!("« {path} » est un sous-module : il n'a pas de contenu à enregistrer."),
            ));
        }
        write_new_file(dest, &blob.data, overwrite)
    }
}

/// Writes `data` to `dest` without ever replacing a file by surprise: without `overwrite`, an
/// existing `dest` is an error (`create_new` makes the check and the creation one step).
/// With it, the bytes land in a temporary file next to `dest` first, so a failure never leaves
/// a truncated file where a good one was.
fn write_new_file(dest: &Path, data: &[u8], overwrite: bool) -> Result<(), YagguiError> {
    let io = |err| BackendError::io(format!("cannot write {}", dest.display()), err);
    if !overwrite {
        let mut file = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dest)
        {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(YagguiError::invalid_argument(
                    format!("\"{}\" already exists.", dest.display()),
                    format!("« {} » existe déjà.", dest.display()),
                ));
            }
            Err(err) => return Err(io(err).into()),
        };
        if let Err(err) = file.write_all(data) {
            drop(file);
            let _ = std::fs::remove_file(dest);
            return Err(io(err).into());
        }
        return Ok(());
    }
    let mut name = dest.file_name().unwrap_or_default().to_owned();
    name.push(format!(".yaggui-{}.tmp", std::process::id()));
    let temp = dest.with_file_name(name);
    let written = std::fs::write(&temp, data).and_then(|()| std::fs::rename(&temp, dest));
    if let Err(err) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(io(err).into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_to_replace_without_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out.txt");
        write_new_file(&dest, b"one", false).unwrap();
        assert!(write_new_file(&dest, b"two", false).is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), b"one");
        write_new_file(&dest, b"two", true).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"two");
    }
}
