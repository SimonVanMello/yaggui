//! Applying one file of a stash (F-185). The stash is never changed.
//!
//! A tracked file gets the stash's change (base → stash commit) merged into it with
//! `git apply --3way`, the patch written by `git diff-tree --output` so its bytes never go
//! through a string. Like `git stash apply` without `--index`: the index entry the file had is
//! put back after a clean merge (the change stays unstaged), a file the stash adds stays
//! staged, and a conflict leaves the unmerged entries and the markers (`stashConflict`).
//! Local changes to the file are refused (`dirtyWorktree`), as `stash apply` refuses them.
//!
//! An untracked file is written from the stash's third parent with `git restore --worktree`,
//! the index untouched; a file already at its path is refused.
//!
//! Either way the file is backed up first and the operation journaled like a discard, so the
//! undo puts the previous file (and index entry) back, also after a conflict.

use std::path::Path;

use gix::ObjectId;
use gix::bstr::BStr;

use crate::events::OpKind;
use crate::git::errors::{BackendError, YagguiError};
use crate::git::ops::types::{JournalOp, StashFileRequest};
use crate::git::read::refs::StashEntry;

use super::RepoManager;
use super::journal::{Mode, Plan};
use super::ref_ops::{classify, raw, stash_entry, unmerged_paths};
use super::write::{Backup, SavedPath, WriteContext, checked_paths};

/// What the apply did (a conflict is still journaled) and the file saved before it.
type Applied = (Result<(), YagguiError>, Vec<SavedPath>);

impl RepoManager {
    pub fn stash_apply_file(
        &self,
        repo_id: u32,
        request: StashFileRequest,
    ) -> Result<(), YagguiError> {
        let backups = self.backup_dir();
        self.journal_op(repo_id, OpKind::Stash, false, false, move |ctx| {
            let backups = backups?;
            let entry = stash_entry(ctx, &request.stash)?;
            let mut paths = checked_paths(ctx.workdir, vec![request.path])?;
            let path = paths.pop().unwrap_or_default();
            let (outcome, saved) = if request.untracked {
                apply_untracked(ctx, &backups, &entry, &path)?
            } else {
                apply_tracked(ctx, &backups, &entry, &path)?
            };
            let op = JournalOp::StashApplyFile {
                message: entry.message,
                path,
            };
            Ok((outcome, Some(Plan::new(op, Mode::Files).with_files(saved))))
        })?
    }
}

/// Mode and blob of `path` in the tree of `commit`; `None` when absent or not a file.
fn file_in(
    ctx: &WriteContext<'_>,
    commit: ObjectId,
    path: &str,
) -> Result<Option<(gix::objs::tree::EntryMode, ObjectId)>, YagguiError> {
    let tree = ctx
        .repo
        .find_commit(commit)
        .map_err(|e| BackendError::gix("read the stash", e))?
        .tree()
        .map_err(|e| BackendError::gix("read the stash tree", e))?;
    Ok(tree
        .lookup_entry_by_path(path)
        .map_err(|e| BackendError::gix("read the stash tree", e))?
        .filter(|e| e.mode().is_blob() || e.mode().is_link())
        .map(|e| (e.mode(), e.object_id())))
}

fn exists(ctx: &WriteContext<'_>, path: &str) -> bool {
    std::fs::symlink_metadata(ctx.workdir.join(path)).is_ok()
}

fn apply_untracked(
    ctx: &WriteContext<'_>,
    backups: &Path,
    entry: &StashEntry,
    path: &str,
) -> Result<Applied, YagguiError> {
    let untracked = entry
        .untracked
        .ok_or_else(|| YagguiError::not_in_stash(path))?;
    if file_in(ctx, untracked, path)?.is_none() {
        return Err(YagguiError::not_in_stash(path));
    }
    if exists(ctx, path) {
        return Err(YagguiError::stash_file_in_the_way(path, true));
    }
    let mut backup = Backup::create(backups, ctx, "stashApplyFile")?;
    backup.save(ctx, path, false)?;
    let (_, saved) = backup.finish()?;
    ctx.run(&ctx.command([
        "--literal-pathspecs".to_owned(),
        "restore".to_owned(),
        format!("--source={untracked}"),
        "--worktree".to_owned(),
        "--".to_owned(),
        path.to_owned(),
    ]))?;
    Ok((Ok(()), saved))
}

fn apply_tracked(
    ctx: &WriteContext<'_>,
    backups: &Path,
    entry: &StashEntry,
    path: &str,
) -> Result<Applied, YagguiError> {
    let base = entry
        .base
        .ok_or_else(|| BackendError::Invariant("a stash commit without parent".into()))?;
    let stashed = file_in(ctx, entry.id, path)?;
    let original = file_in(ctx, base, path)?;
    if stashed == original {
        return Err(YagguiError::not_in_stash(path));
    }
    let staged = ctx
        .index()?
        .entry_by_path(BStr::new(path.as_bytes()))
        .map(|e| (e.mode.bits(), e.id));
    let local = ctx.run(&ctx.command([
        "--literal-pathspecs",
        "diff",
        "--name-only",
        "-z",
        "--",
        path,
    ]))?;
    if !local.stdout.is_empty() {
        return Err(YagguiError::stash_file_in_the_way(path, false));
    }
    match (&staged, original) {
        (None, Some(_)) => return Err(YagguiError::stash_file_missing(path)),
        (None, None) if exists(ctx, path) => {
            return Err(YagguiError::stash_file_in_the_way(path, true));
        }
        _ => {}
    }

    let mut backup = Backup::create(backups, ctx, "stashApplyFile")?;
    backup.save(ctx, path, true)?;
    let patch = backup.dir().join("stash.patch");
    let mut output = std::ffi::OsString::from("--output=");
    output.push(&patch);
    let (_, saved) = backup.finish()?;
    ctx.run(
        &ctx.command([
            "--literal-pathspecs",
            "diff-tree",
            "-p",
            "--binary",
            "--full-index",
            "--no-renames",
        ])
        .arg(base.to_string())
        .arg(entry.id.to_string())
        .arg(output)
        .arg("--")
        .arg(path),
    )?;
    let run = raw(
        ctx,
        &ctx.command(["apply", "--3way", "--whitespace=nowarn"])
            .arg(&patch),
    )?;
    if !run.success {
        let output = format!("{}\n{}", run.stdout, run.stderr);
        if unmerged_paths(ctx)?.iter().any(|p| p == path) {
            let conflict =
                YagguiError::stash_file_conflict(path, entry.id.to_string()).with_detail(output);
            return Ok((Err(conflict), saved));
        }
        if run.stderr.contains("does not match index") {
            return Err(YagguiError::stash_file_in_the_way(path, false).with_detail(&run.stderr));
        }
        return Err(classify(ctx, &run));
    }
    if let Some((mode, id)) = staged {
        // `apply --3way` staged the result; `stash apply` leaves a change to a file the index
        // already had unstaged.
        ctx.run(
            &ctx.command(["update-index", "-z", "--index-info"])
                .stdin(format!("{mode:o} {id}\t{path}\0")),
        )?;
        if let Err(err) = raw(ctx, &ctx.command(["update-index", "-q", "--refresh"])) {
            tracing::debug!(error = %err, "index refresh failed");
        }
    }
    Ok((Ok(()), saved))
}
