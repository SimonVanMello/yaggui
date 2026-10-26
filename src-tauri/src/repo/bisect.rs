//! Assisted bisect (M7-9, F-263): marks given from the graph or the banner, run as
//! `git bisect <term> <sha>` on the repository's queue; the state is read back from `.git`
//! (`git/read/bisect.rs`) after each step. Ending it is `abort_operation` (`git bisect reset`).
//!
//! Each step checks out a commit, so local changes to tracked files refuse a mark: they would
//! be carried into every commit tested. Untracked files stay; one in the way of a checkout
//! leaves the mark saved and the next commit to check out (`bisect_next`). Bisect steps are
//! not journaled: undo and redo refuse to run while a bisect is in progress, and the way
//! back is the bisect's own reset, to the HEAD it started from.
//!
//! A bisect started while the graph is in first-parent mode (F-032) is
//! `git bisect start --first-parent` (Git ≥ 2.29): it only tests the commits the graph shows.
//! Older Git refuses the option; the bisect then starts without it, and its state says so.

use gix::ObjectId;

use crate::events::{OpKind, OpNote};
use crate::git::cli::GitRun;
use crate::git::errors::{BackendError, YagguiError};
use crate::git::ops::types::{BisectMark, BisectState};
use crate::git::read::bisect::{Terms, read_bisect, terms};
use crate::git::read::state::{RepoOperation, count_exclusive, read_operation};
use crate::graph::resolve_commit;

use super::RepoManager;
use super::history::{head_id, rev_arg};
use super::ref_ops::{classify, overwritten_paths, raw, worktree_status};
use super::write::WriteContext;

impl RepoManager {
    /// The bisect in progress, `None` when there is none. Read-only, not queued.
    pub fn bisect_state(&self, repo_id: u32) -> Result<Option<BisectState>, YagguiError> {
        let repo = self.session(repo_id)?.repo()?.to_thread_local();
        read_bisect(&repo)
    }

    /// Marks `rev` (HEAD when `None`) good, bad or skipped; without a bisect in progress, a
    /// good or bad mark starts one. Once a good and a bad commit are known, Git checks out
    /// the next commit to test.
    pub fn bisect_mark(
        &self,
        repo_id: u32,
        rev: Option<String>,
        mark: BisectMark,
    ) -> Result<BisectState, YagguiError> {
        // Read when the job is queued: the mode the user sees when they start the bisect.
        let first_parent = self.session(repo_id)?.graph.filter().first_parent;
        self.write_op(repo_id, OpKind::Bisect, false, move |ctx| {
            bisect_mark(ctx, rev.as_deref(), mark, first_parent)
                .inspect(|state| step_note(ctx, state))
        })
    }

    /// Checks out the next commit to test after a step that could not (`git bisect next`).
    pub fn bisect_next(&self, repo_id: u32) -> Result<BisectState, YagguiError> {
        self.write_op(repo_id, OpKind::Bisect, false, |ctx| {
            if read_operation(ctx.repo) != Some(RepoOperation::Bisect) {
                return Err(YagguiError::no_operation());
            }
            ensure_clean(ctx)?;
            let run = raw(ctx, &ctx.command(["bisect", "next"]))?;
            finish(ctx, &run).inspect(|state| step_note(ctx, state))
        })
    }
}

/// `skip_operation` during a bisect: the same step as a skip mark on HEAD.
pub(super) fn bisect_skip(ctx: &WriteContext<'_>) -> Result<BisectState, YagguiError> {
    // A skip never starts a bisect: the first-parent mode is the one it started with.
    bisect_mark(ctx, None, BisectMark::Skip, false).inspect(|state| step_note(ctx, state))
}

fn bisect_mark(
    ctx: &WriteContext<'_>,
    rev: Option<&str>,
    mark: BisectMark,
    first_parent: bool,
) -> Result<BisectState, YagguiError> {
    let started = match read_operation(ctx.repo) {
        None => false,
        Some(RepoOperation::Bisect) => true,
        Some(_) => return Err(YagguiError::operation_in_progress()),
    };
    if !started && mark == BisectMark::Skip {
        return Err(YagguiError::invalid_argument(
            "No bisect in progress: mark a good or a bad commit to start one.",
            "Aucun bisect en cours : marque un commit bon ou mauvais pour en démarrer un.",
        ));
    }
    let id = match rev {
        Some(rev) => resolve_commit(ctx.repo, rev_arg(rev)?)?,
        None => head_id(ctx)?.ok_or_else(|| YagguiError::revision_not_found("HEAD"))?,
    };
    ensure_clean(ctx)?;
    if started && let Some(mut state) = read_bisect(ctx.repo)? {
        // Checked before Git runs: no mark is recorded for a refused order.
        match mark {
            BisectMark::Good => state.good.push(id.to_string()),
            BisectMark::Bad => state.bad = Some(id.to_string()),
            BisectMark::Skip => {}
        }
        if good_after_bad(ctx.repo, &state)? {
            return Err(YagguiError::bisect_wrong_order());
        }
    }
    let terms = if started {
        terms(ctx.repo.path())
    } else {
        start(ctx, first_parent)?;
        Terms::default()
    };
    let word = match mark {
        BisectMark::Good => terms.good.as_str(),
        BisectMark::Bad => terms.bad.as_str(),
        BisectMark::Skip => "skip",
    };
    let run = raw(ctx, &ctx.command(["bisect", word, &id.to_string()]))?;
    let state = finish(ctx, &run);
    if state.is_err() && !started {
        // The first mark failed: no bisect is left behind for it.
        if let Err(err) = ctx.run(&ctx.command(["bisect", "reset"])) {
            tracing::warn!(repo_id = ctx.repo_id, error = %err, "bisect not reset after a failed start");
        }
    }
    state
}

/// `git bisect start`, along first parents when asked and the Git version has the option.
fn start(ctx: &WriteContext<'_>, first_parent: bool) -> Result<(), YagguiError> {
    if first_parent {
        let run = raw(ctx, &ctx.command(["bisect", "start", "--first-parent"]))?;
        if run.success {
            return Ok(());
        }
        // Git < 2.29: "unrecognized option: '--first-parent'" (or taken as a revision).
        if !run.stderr.contains("first-parent") {
            return Err(classify(ctx, &run));
        }
        tracing::info!(
            repo_id = ctx.repo_id,
            "git bisect has no --first-parent: started without"
        );
    }
    ctx.run(&ctx.command(["bisect", "start"]))?;
    Ok(())
}

/// A step that leaves commits to test says so in `op-finished`, rather than "completed".
fn step_note(ctx: &WriteContext<'_>, state: &BisectState) {
    if state.result.is_none() {
        ctx.op.set_note(OpNote::Step);
    }
}

/// Refuses local changes to tracked files and unresolved conflicts.
fn ensure_clean(ctx: &WriteContext<'_>) -> Result<(), YagguiError> {
    let status = worktree_status(ctx)?;
    if status.unmerged {
        return Err(YagguiError::unresolved_conflicts());
    }
    if !status.tracked.is_empty() {
        return Err(YagguiError::bisect_dirty(
            status.tracked.into_iter().collect(),
        ));
    }
    Ok(())
}

/// The state after a `git bisect` command, or what stopped it.
fn finish(ctx: &WriteContext<'_>, run: &GitRun) -> Result<BisectState, YagguiError> {
    let state = read_bisect(ctx.repo)?.ok_or_else(|| {
        YagguiError::from(BackendError::Invariant(
            "no bisect after a bisect step".into(),
        ))
    })?;
    // Git exits with an error when only skipped commits are left: that is a result.
    if run.success || state.result.is_some() {
        return Ok(state);
    }
    if let Some(paths) = overwritten_paths(&run.stderr) {
        return Err(YagguiError::bisect_checkout_failed(paths).with_detail(&run.stderr));
    }
    if good_after_bad(ctx.repo, &state)? {
        return Err(YagguiError::bisect_wrong_order().with_detail(&run.stderr));
    }
    Err(classify(ctx, run))
}

/// A good commit that descends from the bad one: Git cannot bisect between them. Read from the
/// marks rather than from Git's message, whose wording changes between versions.
fn good_after_bad(repo: &gix::Repository, state: &BisectState) -> Result<bool, YagguiError> {
    let Some(bad) = state.bad.as_deref().and_then(parse_id) else {
        return Ok(false);
    };
    for good in state.good.iter().filter_map(|sha| parse_id(sha)) {
        // The bad commit is an ancestor of the good one: nothing of it is left once hidden.
        if good != bad && count_exclusive(repo, bad, good)? == 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

fn parse_id(sha: &str) -> Option<ObjectId> {
    ObjectId::from_hex(sha.as_bytes()).ok()
}
