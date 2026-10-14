//! File history, blame and reflog services of `RepoManager` (M4-4). Reads only: they do not
//! go through the `OpQueue`, and the long ones (Git walks) can be cancelled by token.
//!
//! Backend choice, measured on git/git (82k commits, commit-graph with Bloom filters):
//! - blame: `git blame --incremental` 1.25 s on `diff.c` (7.9k lines) against 2.2 s for
//!   gix-blame, which also needs a new crate and cannot blame uncommitted content;
//! - file history: `git log -- <path>` per name of the file, 0.14 s for 500 entries, against
//!   1.6 s for `git log --follow`, which cannot use the Bloom filters;
//! - reflog: `gix`, a file read.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use gix::ObjectId;

use crate::git::cli::{CancelToken, GitCommand};
use crate::git::errors::{BackendError, YagguiError};
use crate::git::read::blame::{
    Blame, BlameContent, BlameRequest, is_binary, parse_incremental, split_lines,
};
use crate::git::read::diff::has_symlink_parent;
use crate::git::read::diff::text::decode;
use crate::git::read::diff::types::FileStatus;
use crate::git::read::diff::validate_path;
use crate::git::read::file_history::{
    FILE_HISTORY_PAGE_MAX, FileHistoryCursor, FileHistoryEntry, FileHistoryPage, LOG_FORMAT,
    find_rename, parse_log,
};
use crate::git::read::reflog::{self, ReflogPage};
use crate::graph::resolve_commit;

use super::{RepoManager, RepoSession, lock};

/// A cancellation that arrives before its read started is kept this long.
const EARLY_CANCEL_TTL: Duration = Duration::from_secs(60);

/// Cancel tokens of the reads in progress, by the token the frontend chose.
#[derive(Default)]
pub struct ReadTokens {
    running: Mutex<HashMap<u32, (CancelToken, Instant)>>,
}

impl ReadTokens {
    fn begin(&self, token: u32) -> CancelToken {
        let mut running = lock(&self.running);
        running.retain(|_, (cancel, at)| !cancel.is_cancelled() || at.elapsed() < EARLY_CANCEL_TTL);
        running
            .entry(token)
            .or_insert_with(|| (CancelToken::new(), Instant::now()))
            .0
            .clone()
    }

    fn end(&self, token: u32) {
        lock(&self.running).remove(&token);
    }

    /// Cancels the read `token`, or the read that will start with it.
    pub fn cancel(&self, token: u32) {
        let mut running = lock(&self.running);
        let (cancel, _) = running
            .entry(token)
            .or_insert_with(|| (CancelToken::new(), Instant::now()));
        cancel.cancel();
    }
}

/// Removes the token once the read is done, however it ends.
struct ReadGuard<'a> {
    tokens: &'a ReadTokens,
    token: u32,
    cancel: CancelToken,
}

impl Drop for ReadGuard<'_> {
    fn drop(&mut self) {
        self.tokens.end(self.token);
    }
}

fn not_in_rev(path: &str, rev: &str) -> YagguiError {
    YagguiError::invalid_argument(
        format!("\"{path}\" is not a file of {rev}."),
        format!("« {path} » n'est pas un fichier de {rev}."),
    )
}

impl RepoManager {
    fn read_guard(&self, token: u32) -> ReadGuard<'_> {
        ReadGuard {
            tokens: &self.reads,
            token,
            cancel: self.reads.begin(token),
        }
    }

    pub fn cancel_read(&self, token: u32) {
        self.reads.cancel(token);
    }

    fn read_command<I, S>(&self, session: &RepoSession, args: I) -> GitCommand
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        GitCommand::new(args).cwd(&session.workdir).repo(session.id)
    }

    /// One page of the history of `path` from `rev` (HEAD by default), following renames.
    /// `cursor` continues a previous page.
    pub fn file_history(
        &self,
        repo_id: u32,
        path: &str,
        rev: Option<&str>,
        cursor: Option<FileHistoryCursor>,
        limit: u32,
        token: u32,
    ) -> Result<FileHistoryPage, YagguiError> {
        let guard = self.read_guard(token);
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        let mut cursor = match cursor {
            Some(cursor) => {
                validate_path(&cursor.path)?;
                let rev = resolve_commit(&repo, &cursor.rev)?.to_string();
                FileHistoryCursor { rev, ..cursor }
            }
            None => {
                validate_path(path)?;
                let start = match rev {
                    Some(rev) => resolve_commit(&repo, rev)?,
                    None => match repo.head_id() {
                        Ok(id) => id.detach(),
                        // Unborn branch: no history yet.
                        Err(_) => {
                            return Ok(FileHistoryPage {
                                entries: Vec::new(),
                                next: None,
                            });
                        }
                    },
                };
                FileHistoryCursor {
                    rev: start.to_string(),
                    path: path.to_owned(),
                    skip: 0,
                }
            }
        };
        let limit = limit.clamp(1, FILE_HISTORY_PAGE_MAX);
        let mut entries: Vec<FileHistoryEntry> = Vec::new();
        loop {
            let need = limit - u32::try_from(entries.len()).unwrap_or(limit);
            // One more than needed: when the name's history ends on this page, its first
            // commit is here to look for a rename.
            let command = self
                .read_command(
                    &session,
                    [
                        "--literal-pathspecs",
                        "-c",
                        "log.showSignature=false",
                        "-c",
                        "log.follow=false",
                        "log",
                        LOG_FORMAT,
                        "--name-status",
                        "-z",
                        "--no-renames",
                        "--no-ext-diff",
                        "--no-color",
                    ],
                )
                .arg(format!("--skip={}", cursor.skip))
                .arg(format!("--max-count={}", need + 1))
                .arg(&cursor.rev)
                .arg("--")
                .arg(&cursor.path);
            let output = self.git.run_with(&command, Some(&guard.cancel), None)?;
            let mut found = parse_log(&output.stdout, &cursor.path);
            if found.len() > need as usize {
                found.truncate(need as usize);
                entries.extend(found);
                cursor.skip += need;
                return Ok(FileHistoryPage {
                    entries,
                    next: Some(cursor),
                });
            }
            let renamed = match found.last_mut() {
                Some(first) if first.status == FileStatus::Added => {
                    self.rename_source(&session, first, &guard.cancel)?
                }
                _ => None,
            };
            entries.extend(found);
            let Some(next) = renamed else {
                return Ok(FileHistoryPage {
                    entries,
                    next: None,
                });
            };
            cursor = next;
            if entries.len() >= limit as usize {
                return Ok(FileHistoryPage {
                    entries,
                    next: Some(cursor),
                });
            }
        }
    }

    /// When the commit that added `entry.path` renamed it from another path, marks the entry
    /// as a rename and returns where the history goes on (its first parent, old name).
    fn rename_source(
        &self,
        session: &RepoSession,
        entry: &mut FileHistoryEntry,
        cancel: &CancelToken,
    ) -> Result<Option<FileHistoryCursor>, YagguiError> {
        let Some(parent) = entry.parents.first().cloned() else {
            return Ok(None);
        };
        let command = self
            .read_command(
                session,
                [
                    "diff-tree",
                    "-r",
                    "--find-renames",
                    "--name-status",
                    "-z",
                    "--no-ext-diff",
                    "--no-color",
                ],
            )
            .arg(&parent)
            .arg(&entry.sha);
        let output = self.git.run_with(&command, Some(cancel), None)?;
        let Some((old_path, similarity)) = find_rename(&output.stdout, &entry.path) else {
            return Ok(None);
        };
        entry.status = FileStatus::Renamed;
        entry.old_path = Some(old_path.clone());
        entry.similarity = similarity;
        Ok(Some(FileHistoryCursor {
            rev: parent,
            path: old_path,
            skip: 0,
        }))
    }

    /// Blame of `request.path` at `request.rev`, or of the working tree file.
    pub fn blame(
        &self,
        repo_id: u32,
        request: &BlameRequest,
        token: u32,
    ) -> Result<Blame, YagguiError> {
        let guard = self.read_guard(token);
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        let path = request.path.as_str();
        validate_path(path)?;
        let (rev, bytes) = match &request.rev {
            Some(rev) => {
                let id = resolve_commit(&repo, rev)?;
                (Some(id), blob_at(&repo, id, path, rev)?)
            }
            None => {
                if !in_head(&repo, path)? {
                    return Ok(Blame {
                        path: path.to_owned(),
                        rev: None,
                        content: BlameContent::NotCommitted,
                    });
                }
                match worktree_bytes(&session.workdir, path)? {
                    Some(bytes) => (None, bytes),
                    // Deleted from the working tree: its last committed version.
                    None => {
                        let head = resolve_commit(&repo, "HEAD")?;
                        (Some(head), blob_at(&repo, head, path, "HEAD")?)
                    }
                }
            }
        };
        let blame = |content| Blame {
            path: path.to_owned(),
            rev: rev.map(|id| id.to_string()),
            content,
        };
        if is_binary(&bytes) {
            #[allow(clippy::cast_precision_loss)] // Shown rounded.
            return Ok(blame(BlameContent::Binary {
                size: bytes.len() as f64,
            }));
        }
        let mut command = self.read_command(&session, ["blame", "--incremental"]);
        command = match rev {
            Some(id) => command.arg(id.to_string()),
            // The bytes read above, so the lines match the attribution even if the file
            // changes meanwhile.
            None => command.arg("--contents").arg("-").stdin(bytes.clone()),
        };
        let output = self
            .git
            .run_with(&command.arg("--").arg(path), Some(&guard.cancel), None)?;
        let (commits, chunks) = parse_incremental(&output.stdout);
        let (text, encoding) = decode(&bytes);
        Ok(blame(BlameContent::Text {
            lines: split_lines(&text),
            encoding,
            commits,
            chunks,
        }))
    }

    /// Entries `start .. start + limit` of the reflog of `reference` (`HEAD`, `refs/heads/…`).
    pub fn reflog(
        &self,
        repo_id: u32,
        reference: &str,
        start: u32,
        limit: u32,
    ) -> Result<ReflogPage, YagguiError> {
        let repo = self.session(repo_id)?.repo()?.to_thread_local();
        reflog::read(&repo, reference, start, limit)
    }
}

/// Whether HEAD has a file at `path` (false on an unborn branch).
fn in_head(repo: &gix::Repository, path: &str) -> Result<bool, YagguiError> {
    let Ok(commit) = repo.head_commit() else {
        return Ok(false);
    };
    let tree = commit
        .tree()
        .map_err(|err| BackendError::gix("read the HEAD tree", err))?;
    Ok(tree
        .lookup_entry_by_path(path)
        .map_err(|err| BackendError::gix("read the HEAD tree", err))?
        .is_some_and(|entry| entry.mode().is_blob() || entry.mode().is_link()))
}

fn blob_at(
    repo: &gix::Repository,
    commit: ObjectId,
    path: &str,
    rev: &str,
) -> Result<Vec<u8>, YagguiError> {
    let tree = repo
        .find_commit(commit)
        .and_then(|c| c.tree())
        .map_err(|err| BackendError::gix("read the commit tree", err))?;
    let entry = tree
        .lookup_entry_by_path(path)
        .map_err(|err| BackendError::gix("read the commit tree", err))?
        .filter(|entry| entry.mode().is_blob() || entry.mode().is_link())
        .ok_or_else(|| not_in_rev(path, rev))?;
    let object = entry
        .object()
        .map_err(|err| BackendError::gix("read the file", err))?;
    Ok(object.detach().data)
}

/// Content of the working tree file, `None` when it was deleted.
fn worktree_bytes(workdir: &Path, path: &str) -> Result<Option<Vec<u8>>, YagguiError> {
    if has_symlink_parent(workdir, path.as_bytes().into()) {
        return Err(YagguiError::invalid_argument(
            format!("\"{path}\" is inside a symbolic link."),
            format!("« {path} » est dans un lien symbolique."),
        ));
    }
    let full = workdir.join(path);
    let meta = match std::fs::symlink_metadata(&full) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(BackendError::io(format!("cannot read {path}"), err).into()),
    };
    // Git stores a symbolic link as its target: blame that text.
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(&full)
            .map_err(|err| BackendError::io(format!("cannot read {path}"), err))?;
        return Ok(Some(target.to_string_lossy().into_owned().into_bytes()));
    }
    if !meta.is_file() {
        return Err(not_in_rev(path, "the working tree"));
    }
    std::fs::read(&full)
        .map(Some)
        .map_err(|err| BackendError::io(format!("cannot read {path}"), err).into())
}
