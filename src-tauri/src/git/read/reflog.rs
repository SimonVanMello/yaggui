//! Reflog of HEAD or of a branch (F-222), read through `gix`: a plain file, no process.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::git::errors::{BackendError, YagguiError};

/// Maximum entries per page.
pub const REFLOG_PAGE_MAX: u32 = 500;

/// One move of the reference.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReflogEntry {
    /// `n` of `<ref>@{n}`: 0 is the latest move.
    pub index: u32,
    /// Where the reference pointed after the move (full SHA).
    pub new_sha: String,
    /// Where it pointed before; `None` when it was created by this move.
    pub old_sha: Option<String>,
    /// As written by Git: `commit: …`, `checkout: moving from a to b`, `reset: moving to …`.
    pub message: String,
    pub committer_name: String,
    /// Seconds since the Unix epoch.
    pub time: f64,
    /// `false` when the commit is gone (pruned): it cannot be restored.
    pub exists: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReflogPage {
    /// Full name of the reference: `HEAD` or `refs/heads/<branch>`.
    pub reference: String,
    /// Newest first.
    pub entries: Vec<ReflogEntry>,
    /// Entries in the whole reflog.
    pub total: u32,
}

/// `HEAD`, `refs/heads/…` or `refs/remotes/…`: the references Git keeps a reflog for.
pub fn validate_reference(name: &str) -> Result<(), YagguiError> {
    let known =
        name == "HEAD" || name.starts_with("refs/heads/") || name.starts_with("refs/remotes/");
    let valid = gix::refs::FullName::try_from(name).is_ok();
    if known && valid && !name.contains("..") {
        Ok(())
    } else {
        Err(YagguiError::invalid_argument(
            format!("\"{name}\" has no reflog yaggui can show."),
            format!("« {name} » n'a pas de reflog que yaggui puisse afficher."),
        ))
    }
}

#[allow(clippy::cast_precision_loss)] // Exact up to 2^53 seconds.
fn seconds_f64(seconds: i64) -> f64 {
    seconds as f64
}

/// Entries `start .. start + limit` of the reflog of `name`, newest first. A reference
/// without reflog (`core.logAllRefUpdates` off, a fresh clone's remote branch) has none.
pub fn read(
    repo: &gix::Repository,
    name: &str,
    start: u32,
    limit: u32,
) -> Result<ReflogPage, YagguiError> {
    validate_reference(name)?;
    let gix_err = |context: &'static str| move |err| BackendError::gix(context, err);
    let reference = repo
        .try_find_reference(name)
        .map_err(gix_err("find the reference"))?
        .ok_or_else(|| YagguiError::revision_not_found(name))?;
    let mut platform = reference.log_iter();
    let mut lines = Vec::new();
    if let Some(iter) = platform
        .all()
        .map_err(|err| BackendError::io(format!("cannot read the reflog of {name}"), err))?
    {
        // A line Git could not have written (hand edits) is skipped, not fatal.
        lines.extend(iter.filter_map(Result::ok).map(|line| {
            let old = line.previous_oid();
            (
                line.new_oid(),
                (!old.is_null()).then_some(old),
                line.message.to_string(),
                line.signature.name.to_string(),
                line.signature.seconds(),
            )
        }));
    }
    let total = u32::try_from(lines.len()).unwrap_or(u32::MAX);
    let entries = lines
        .into_iter()
        .rev()
        .enumerate()
        .skip(start as usize)
        .take(limit.min(REFLOG_PAGE_MAX) as usize)
        .map(
            |(index, (new, old, message, committer, seconds))| ReflogEntry {
                index: u32::try_from(index).unwrap_or(u32::MAX),
                exists: !new.is_null() && repo.has_object(new),
                new_sha: new.to_string(),
                old_sha: old.map(|id| id.to_string()),
                message,
                committer_name: committer,
                time: seconds_f64(seconds),
            },
        )
        .collect();
    Ok(ReflogPage {
        reference: name.to_owned(),
        entries,
        total,
    })
}
