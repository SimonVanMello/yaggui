//! Merge, rebase, cherry-pick, revert and reset services of `RepoManager` (M3-1), and the
//! operation in progress (continue, skip, abort) with its conflicts. Every write runs on the
//! repository's `OpQueue` and goes through `git/cli.rs`.

use std::collections::BTreeMap;

use gix::ObjectId;

use crate::events::{OpKind, OpNote};
use crate::git::cli::{GitCommand, GitRun};
use crate::git::errors::{BackendError, HistoryOp, YagguiError};
use crate::git::ops::types::{
    CherryPickRequest, CommitRequest, ConflictList, ConflictResolution, ConflictStage,
    ConflictVersions, FastForwardRequest, FastForwardResult, HistoryEffect, HistoryResult,
    JournalOp, LostChange, LostFile, MergeMode, MergeRequest, MergeToolResult, OperationDetail,
    RebaseRequest, ResetMode, ResetPreview, ResetRequest, ResetResult, RevertRequest,
    RevisionRelation,
};
use crate::git::read::operation;
use crate::git::read::state::{RepoOperation, count_exclusive, gix as gix_err, read_operation};
use crate::graph::resolve_commit;

use super::RepoManager;
use super::bisect::bisect_skip;
use super::journal::{Mode, Plan};
use super::ref_ops::{
    classify, current_branch, existing_branch, overwritten_paths, raw, unmerged_paths,
    worktree_status,
};
use super::write::{Backup, WriteContext, checked_paths, commit, split_message};

impl RepoManager {
    pub fn merge(&self, repo_id: u32, request: MergeRequest) -> Result<HistoryResult, YagguiError> {
        self.journal_op(repo_id, OpKind::Merge, true, false, move |ctx| {
            let result = merge(ctx, &request)?;
            let op = JournalOp::Merge {
                source: request.source.trim().to_owned(),
                mode: request.mode,
            };
            Ok((result, Some(Plan::new(op, Mode::Keep))))
        })
    }

    /// Moves `request.branch` forward to `request.to`. The checked-out branch moves with the
    /// working tree (`merge --ff-only`); any other branch only has its ref moved, so it never
    /// needs a checkout.
    pub fn fast_forward(
        &self,
        repo_id: u32,
        request: FastForwardRequest,
    ) -> Result<FastForwardResult, YagguiError> {
        self.journal_op(repo_id, OpKind::Merge, true, false, move |ctx| {
            let (result, mode) = fast_forward(ctx, &request)?;
            let op = JournalOp::FastForward {
                branch: request.branch.trim().to_owned(),
                to: request.to.trim().to_owned(),
            };
            let plan = (!result.up_to_date).then(|| Plan::new(op, mode));
            Ok((result, plan))
        })
    }

    /// How `a` and `b` relate: which one, if any, can be fast-forwarded to the other. Read-only.
    pub fn revision_relation(
        &self,
        repo_id: u32,
        a: &str,
        b: &str,
    ) -> Result<RevisionRelation, YagguiError> {
        let repo = self.session(repo_id)?.repo()?.to_thread_local();
        let (a, b) = (
            resolve_commit(&repo, rev_arg(a)?)?,
            resolve_commit(&repo, rev_arg(b)?)?,
        );
        relation(&repo, a, b)
    }

    pub fn rebase(
        &self,
        repo_id: u32,
        request: RebaseRequest,
    ) -> Result<HistoryResult, YagguiError> {
        self.write_op(repo_id, OpKind::Rebase, true, move |ctx| {
            rebase(ctx, &request)
        })
    }

    pub fn cherry_pick(
        &self,
        repo_id: u32,
        request: CherryPickRequest,
    ) -> Result<HistoryResult, YagguiError> {
        let commits = self.graph_order(repo_id, &request.commits)?;
        self.journal_op(repo_id, OpKind::CherryPick, true, false, move |ctx| {
            let result = cherry_pick(ctx, &commits, request.mainline)?;
            let count = u32::try_from(commits.len()).unwrap_or(u32::MAX);
            let op = JournalOp::CherryPick { count };
            Ok((result, Some(Plan::new(op, Mode::Keep))))
        })
    }

    pub fn revert(
        &self,
        repo_id: u32,
        request: RevertRequest,
    ) -> Result<HistoryResult, YagguiError> {
        self.journal_op(repo_id, OpKind::Revert, true, false, move |ctx| {
            let result = revert(ctx, &request)?;
            let sha = resolve_commit(ctx.repo, rev_arg(&request.commit)?)?.to_string();
            Ok((
                result,
                Some(Plan::new(JournalOp::Revert { sha }, Mode::Keep)),
            ))
        })
    }

    pub fn reset_preview(&self, repo_id: u32, target: &str) -> Result<ResetPreview, YagguiError> {
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        let target = resolve_commit(&repo, target)?;
        let status = GitCommand::new(STATUS_ARGS)
            .cwd(&session.workdir)
            .repo(repo_id);
        let status = self.git.run(&status)?.stdout;
        preview(&repo, target, &status)
    }

    pub fn reset(&self, repo_id: u32, request: ResetRequest) -> Result<ResetResult, YagguiError> {
        let backups = self.backup_dir()?;
        let mixed = request.mode == ResetMode::Mixed;
        self.journal_op(repo_id, OpKind::Reset, false, mixed, move |ctx| {
            let target = resolve_commit(ctx.repo, &request.target)?;
            let previous = head_id(ctx)?
                .ok_or_else(|| YagguiError::revision_not_found("HEAD"))?
                .to_string();
            let mut backup_id = None;
            let mut saved = Vec::new();
            if request.mode == ResetMode::Hard {
                let status = ctx.run(&ctx.command(STATUS_ARGS))?.stdout;
                let lost = preview(ctx.repo, target, &status)?.hard_lost;
                if !lost.is_empty() {
                    let mut backup = Backup::create(&backups, ctx, "resetHard")?;
                    for file in &lost {
                        backup.save(ctx, &file.path, true)?;
                    }
                    let (id, files) = backup.finish()?;
                    backup_id = Some(id);
                    saved = files;
                }
            }
            let mode = match request.mode {
                ResetMode::Soft => "--soft",
                ResetMode::Mixed => "--mixed",
                ResetMode::Hard => "--hard",
            };
            ctx.run(&ctx.command(["reset", "-q", mode, &target.to_string(), "--"]))?;
            let op = JournalOp::Reset {
                mode: request.mode,
                target: request.target.trim().to_owned(),
            };
            let plan = match request.mode {
                ResetMode::Hard => Plan::new(op, Mode::HardReset).with_files(saved),
                ResetMode::Soft | ResetMode::Mixed => Plan::new(op, Mode::Refs),
            };
            let result = ResetResult {
                previous_head: previous,
                head: target.to_string(),
                backup_id,
            };
            Ok((result, Some(plan)))
        })
    }

    pub fn operation_detail(&self, repo_id: u32) -> Result<Option<OperationDetail>, YagguiError> {
        let repo = self.session(repo_id)?.repo()?.to_thread_local();
        operation::read_detail(&repo)
    }

    pub fn continue_operation(
        &self,
        repo_id: u32,
        message: Option<String>,
    ) -> Result<HistoryResult, YagguiError> {
        let kind = self.operation_kind(repo_id)?;
        self.write_op(repo_id, kind, true, move |ctx| {
            let result = continue_operation(ctx, message.as_deref())?;
            note_if_halted(ctx);
            Ok(result)
        })
    }

    pub fn skip_operation(&self, repo_id: u32) -> Result<HistoryResult, YagguiError> {
        let kind = self.operation_kind(repo_id)?;
        self.write_op(repo_id, kind, true, |ctx| {
            let result = skip_operation(ctx)?;
            note_if_halted(ctx);
            Ok(result)
        })
    }

    pub fn abort_operation(&self, repo_id: u32) -> Result<(), YagguiError> {
        let kind = self.operation_kind(repo_id)?;
        self.write_op(repo_id, kind, false, |ctx| {
            abort_operation(ctx)?;
            ctx.op.set_note(OpNote::Aborted);
            Ok(())
        })
    }

    pub fn list_conflicts(&self, repo_id: u32) -> Result<ConflictList, YagguiError> {
        let repo = self.session(repo_id)?.repo()?.to_thread_local();
        operation::read_conflicts(&repo)
    }

    pub fn resolve_conflicts(
        &self,
        repo_id: u32,
        paths: Vec<String>,
        resolution: ConflictResolution,
    ) -> Result<(), YagguiError> {
        self.write_op(repo_id, OpKind::Stage, false, move |ctx| {
            resolve_conflicts(ctx, paths, &resolution)
        })
    }

    pub fn conflict_versions(
        &self,
        repo_id: u32,
        path: &str,
    ) -> Result<ConflictVersions, YagguiError> {
        let session = self.session(repo_id)?;
        let path = checked_paths(&session.workdir, vec![path.to_owned()])?.remove(0);
        let repo = session.repo()?.to_thread_local();
        operation::read_versions(&repo, &session.workdir, &path)
    }

    pub fn conflict_image(
        &self,
        repo_id: u32,
        path: &str,
        stage: ConflictStage,
    ) -> Result<Option<String>, YagguiError> {
        let session = self.session(repo_id)?;
        let path = checked_paths(&session.workdir, vec![path.to_owned()])?.remove(0);
        let repo = session.repo()?.to_thread_local();
        operation::read_image(&repo, &path, stage)
    }

    pub fn merge_tool(&self, repo_id: u32) -> Result<Option<String>, YagguiError> {
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        // The merge tool of the preferences (F-323) wins over `merge.tool`.
        Ok(self
            .store
            .preferences()?
            .merge_tool
            .or_else(|| operation::merge_tool(&repo)))
    }

    /// Runs `git mergetool` with the configured tool on one conflicted file and waits for the
    /// tool to close. Cancelling kills the tool with Git.
    pub fn run_merge_tool(
        &self,
        repo_id: u32,
        path: String,
    ) -> Result<MergeToolResult, YagguiError> {
        let preferred = self.store.preferences()?.merge_tool;
        self.write_op(repo_id, OpKind::MergeTool, true, move |ctx| {
            run_merge_tool(ctx, path, preferred)
        })
    }

    /// `OpKind` of a continue / skip / abort: the family of the operation in progress.
    fn operation_kind(&self, repo_id: u32) -> Result<OpKind, YagguiError> {
        let repo = self.session(repo_id)?.repo()?.to_thread_local();
        Ok(match read_operation(&repo) {
            None => return Err(YagguiError::no_operation()),
            Some(RepoOperation::Merge { .. }) => OpKind::Merge,
            Some(RepoOperation::Rebase { .. }) => OpKind::Rebase,
            Some(RepoOperation::CherryPick) => OpKind::CherryPick,
            Some(RepoOperation::Revert) => OpKind::Revert,
            Some(RepoOperation::ApplyMailbox) => OpKind::ApplyMailbox,
            Some(RepoOperation::Bisect) => OpKind::Bisect,
        })
    }

    /// Resolves `revs` and sorts them oldest first, in the order of the graph (rows go from
    /// the newest commit down). Commits outside the graph come last, by commit time.
    fn graph_order(&self, repo_id: u32, revs: &[String]) -> Result<Vec<ObjectId>, YagguiError> {
        if revs.is_empty() {
            return Err(YagguiError::invalid_argument(
                "No commit to cherry-pick.",
                "Aucun commit à cherry-picker.",
            ));
        }
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        let mut ids = Vec::new();
        for rev in revs {
            let id = resolve_commit(&repo, rev)?;
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        if ids.len() < 2 {
            return Ok(ids);
        }
        let time = |id: &ObjectId| {
            repo.find_commit(*id)
                .ok()
                .and_then(|c| c.time().ok())
                .map_or(0, |t| t.seconds)
        };
        let mut keyed = session.read_graph(&repo, |snapshot| {
            ids.iter()
                .map(|&id| {
                    let key = match snapshot.find_row(&repo.objects, &id)? {
                        Some(row) => (0, -i64::from(row), 0),
                        None => (1, 0, time(&id)),
                    };
                    Ok((key, id))
                })
                .collect::<Result<Vec<_>, YagguiError>>()
        })?;
        keyed.sort_by_key(|(key, _)| *key);
        Ok(keyed.into_iter().map(|(_, id)| id).collect())
    }
}

pub(super) const STATUS_ARGS: [&str; 5] = [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=dirty",
];

pub(super) fn head_id(ctx: &WriteContext<'_>) -> Result<Option<ObjectId>, YagguiError> {
    let head = ctx.repo.head().map_err(gix_err("read HEAD"))?;
    Ok(head.id().map(gix::Id::detach))
}

/// Refuses to start an operation over another one or over unresolved conflicts.
pub(super) fn ensure_idle(ctx: &WriteContext<'_>) -> Result<(), YagguiError> {
    if read_operation(ctx.repo).is_some() {
        return Err(YagguiError::operation_in_progress());
    }
    if !unmerged_paths(ctx)?.is_empty() {
        return Err(YagguiError::unresolved_conflicts());
    }
    Ok(())
}

/// A revision as typed, refused when it could be read as an option.
pub(super) fn rev_arg(rev: &str) -> Result<&str, YagguiError> {
    let rev = rev.trim();
    if rev.is_empty() || rev.starts_with('-') {
        return Err(YagguiError::revision_not_found(rev));
    }
    Ok(rev)
}

/// Runs a history command, forwarding `Rebasing (n/m)` as progress.
pub(super) fn run_history(
    ctx: &WriteContext<'_>,
    command: &GitCommand,
) -> Result<GitRun, YagguiError> {
    ctx.run_progress(command)
}

/// Why a history command failed: stopped on conflicts (now in progress), on an empty
/// commit, blocked by local changes, or a catalog error.
pub(super) fn failure(ctx: &WriteContext<'_>, op: HistoryOp, run: &GitRun) -> YagguiError {
    let operation = read_operation(ctx.repo);
    match unmerged_paths(ctx) {
        Ok(paths) if !paths.is_empty() => {
            return YagguiError::conflicts(operation, paths).with_detail(&run.stderr);
        }
        Ok(_) => {}
        Err(err) => return err,
    }
    let tracked = || {
        worktree_status(ctx)
            .map(|s| s.tracked.into_iter().collect::<Vec<_>>())
            .unwrap_or_default()
    };
    if let Some(paths) = overwritten_paths(&run.stderr) {
        let paths = if paths.is_empty() { tracked() } else { paths };
        return YagguiError::local_changes(op, paths).with_detail(&run.stderr);
    }
    let lower = run.stderr.to_ascii_lowercase();
    if lower.contains("cannot rebase: you have unstaged changes")
        || lower.contains("cannot rebase: your index contains uncommitted changes")
        || lower.contains("your local changes would be overwritten")
    {
        return YagguiError::local_changes(op, tracked()).with_detail(&run.stderr);
    }
    if lower.contains("not possible to fast-forward") {
        return YagguiError::not_fast_forward().with_detail(&run.stderr);
    }
    let picking = matches!(
        operation,
        Some(RepoOperation::CherryPick | RepoOperation::Revert)
    );
    if picking && (lower.contains("is now empty") || lower.contains("nothing to commit")) {
        let head = ["CHERRY_PICK_HEAD", "REVERT_HEAD"]
            .iter()
            .find_map(|name| std::fs::read_to_string(ctx.repo.path().join(name)).ok());
        return YagguiError::empty_commit(head.as_deref().map(str::trim)).with_detail(&run.stderr);
    }
    classify(ctx, run)
}

/// Runs `command`; a failure is explained by [`failure`].
fn run_op(ctx: &WriteContext<'_>, op: HistoryOp, command: &GitCommand) -> Result<(), YagguiError> {
    let run = run_history(ctx, command)?;
    if run.success {
        Ok(())
    } else {
        Err(failure(ctx, op, &run))
    }
}

/// What the operation did, from where the moved branch was to where HEAD is now.
pub(super) fn result(
    ctx: &WriteContext<'_>,
    previous: Option<ObjectId>,
    fast_forward_to: Option<ObjectId>,
) -> Result<HistoryResult, YagguiError> {
    let head = head_id(ctx)?.ok_or_else(|| YagguiError::revision_not_found("HEAD"))?;
    let effect = if Some(head) == previous {
        HistoryEffect::UpToDate
    } else if Some(head) == fast_forward_to {
        HistoryEffect::FastForward
    } else {
        HistoryEffect::Commits
    };
    Ok(HistoryResult {
        effect,
        head: head.to_string(),
        previous_head: previous.map(|id| id.to_string()),
    })
}

fn message_or(message: Option<&str>) -> Option<&str> {
    message.map(str::trim).filter(|m| !m.is_empty())
}

/// Commits the index with `message` (hooks run, errors typed like a regular commit).
fn commit_with(ctx: &WriteContext<'_>, message: &str) -> Result<(), YagguiError> {
    let split = split_message(message);
    commit(
        ctx,
        &CommitRequest {
            summary: split.summary,
            description: split.description,
            amend: false,
            skip_hooks: false,
        },
    )
    .map(drop)
}

fn merge(ctx: &WriteContext<'_>, request: &MergeRequest) -> Result<HistoryResult, YagguiError> {
    ensure_idle(ctx)?;
    let source_rev = rev_arg(&request.source)?;
    let source = resolve_commit(ctx.repo, source_rev)?;
    let Some(head) = head_id(ctx)? else {
        return Err(YagguiError::invalid_argument(
            "There is no commit to merge into yet.",
            "Il n'y a pas encore de commit dans lequel merger.",
        ));
    };
    if count_exclusive(ctx.repo, source, head)? == 0 {
        return result(ctx, Some(head), None);
    }
    let mode = match request.mode {
        MergeMode::FastForward => "--ff",
        MergeMode::FastForwardOnly => "--ff-only",
        MergeMode::NoFastForward => "--no-ff",
        MergeMode::Squash => "--squash",
    };
    let mut command = ctx.command(["merge", mode, "--no-edit"]);
    let message = message_or(request.message.as_deref());
    if let (Some(message), false) = (message, request.mode == MergeMode::Squash) {
        command = command.arg("-m").arg(message);
    }
    let command = command.arg("--").arg(source_rev);
    let run = run_history(ctx, &command)?;
    if !run.success {
        let err = failure(ctx, HistoryOp::Merge, &run);
        return Err(
            if err.code == crate::git::errors::ErrorCode::NotFastForward {
                YagguiError::merge_not_fast_forward(source_rev).with_detail(&run.stderr)
            } else {
                err
            },
        );
    }
    if request.mode == MergeMode::Squash {
        let squash = RepoOperation::Merge { squash: true };
        // Nothing staged: the content was already there (`nothing to squash`).
        if read_operation(ctx.repo) == Some(squash.clone()) {
            let prepared = operation::prepared_message(ctx.repo, &squash);
            let text = message
                .map(str::to_owned)
                .or(prepared)
                .unwrap_or_else(|| format!("Squashed commit of {source_rev}"));
            commit_with(ctx, &text)?;
        }
    }
    result(ctx, Some(head), Some(source))
}

fn relation(
    repo: &gix::Repository,
    a: ObjectId,
    b: ObjectId,
) -> Result<RevisionRelation, YagguiError> {
    if a == b {
        return Ok(RevisionRelation::Same);
    }
    let base = repo
        .merge_base(a, b)
        .map_err(|e| BackendError::gix("find the merge-base", e))?
        .map(gix::Id::detach);
    Ok(match base {
        Some(base) if base == a => RevisionRelation::Behind,
        Some(base) if base == b => RevisionRelation::Ahead,
        _ => RevisionRelation::Diverged,
    })
}

fn fast_forward(
    ctx: &WriteContext<'_>,
    request: &FastForwardRequest,
) -> Result<(FastForwardResult, Mode), YagguiError> {
    let branch = request.branch.trim();
    let previous = existing_branch(ctx, branch)?;
    let to_rev = rev_arg(&request.to)?;
    let to = resolve_commit(ctx.repo, to_rev)?;
    let done = |sha: ObjectId| FastForwardResult {
        up_to_date: sha == previous,
        previous: previous.to_string(),
        sha: sha.to_string(),
    };
    match relation(ctx.repo, previous, to)? {
        RevisionRelation::Same | RevisionRelation::Ahead => {
            return Ok((done(previous), Mode::Refs));
        }
        RevisionRelation::Diverged => return Err(YagguiError::merge_not_fast_forward(to_rev)),
        RevisionRelation::Behind => {}
    }
    // Also for another branch: a rebase or bisect in progress may write it when it ends.
    ensure_idle(ctx)?;
    if current_branch(ctx.repo)?.as_deref() == Some(branch) {
        let command = ctx.command(["merge".to_owned(), "--ff-only".to_owned(), to.to_string()]);
        run_op(ctx, HistoryOp::Merge, &command)?;
        return Ok((done(to), Mode::Keep));
    }
    // A SHA, not the name: a remote-tracking start point would set up tracking.
    let run = raw(ctx, &ctx.command(["branch", "-f", branch, &to.to_string()]))?;
    if !run.success {
        // `cannot force update the branch 'x' used by worktree at '/path'`
        let lower = run.stderr.to_ascii_lowercase();
        if lower.contains("used by worktree") || lower.contains("cannot force update") {
            let path = run
                .stderr
                .lines()
                .find(|line| line.contains("used by worktree at"))
                .and_then(|line| line.rsplit('\'').nth(1));
            return Err(
                YagguiError::branch_in_other_worktree(branch, path).with_detail(&run.stderr)
            );
        }
        return Err(classify(ctx, &run));
    }
    Ok((done(to), Mode::Refs))
}

fn rebase(ctx: &WriteContext<'_>, request: &RebaseRequest) -> Result<HistoryResult, YagguiError> {
    ensure_idle(ctx)?;
    let onto = resolve_commit(ctx.repo, rev_arg(&request.onto)?)?;
    let (branch, previous) = match &request.branch {
        Some(name) => (Some(name.as_str()), existing_branch(ctx, name)?),
        None => {
            if ctx
                .repo
                .head_name()
                .map_err(gix_err("read HEAD"))?
                .is_none()
            {
                return Err(YagguiError::detached_head());
            }
            let head = head_id(ctx)?.ok_or_else(|| YagguiError::revision_not_found("HEAD"))?;
            (None, head)
        }
    };
    let status = worktree_status(ctx)?;
    if !status.tracked.is_empty() {
        return Err(YagguiError::local_changes(
            HistoryOp::Rebase,
            status.tracked.into_iter().collect(),
        ));
    }
    // A SHA rather than the name: `git rebase` takes no `--` before its revisions.
    let mut command = ctx.command(["rebase".to_owned(), onto.to_string()]);
    if let Some(branch) = branch {
        command = command.arg(branch);
    }
    run_op(ctx, HistoryOp::Rebase, &command)?;
    result(ctx, Some(previous), Some(onto))
}

/// Number of parents of `id`.
fn parent_count(repo: &gix::Repository, id: ObjectId) -> Result<usize, YagguiError> {
    Ok(repo
        .find_commit(id)
        .map_err(gix_err("read a commit"))?
        .parent_ids()
        .count())
}

fn check_mainline(
    repo: &gix::Repository,
    commits: &[ObjectId],
    mainline: Option<u32>,
    allow_plain: bool,
) -> Result<(), YagguiError> {
    for id in commits {
        let parents = parent_count(repo, *id)?;
        let invalid = |n: u32| {
            YagguiError::invalid_argument(
                format!("Parent {n} does not exist for {}.", &id.to_string()[..7]),
                format!("{} n'a pas de parent {n}.", &id.to_string()[..7]),
            )
        };
        match mainline {
            None if parents > 1 => return Err(YagguiError::mainline_required(&id.to_string())),
            None => {}
            Some(0) => return Err(invalid(0)),
            Some(n) if parents > 1 && n as usize > parents => return Err(invalid(n)),
            // Git accepts `-m 1` on a plain commit (its only parent), nothing else.
            Some(n) if parents < 2 && (n > 1 || !allow_plain) => return Err(invalid(n)),
            Some(_) => {}
        }
    }
    Ok(())
}

fn cherry_pick(
    ctx: &WriteContext<'_>,
    commits: &[ObjectId],
    mainline: Option<u32>,
) -> Result<HistoryResult, YagguiError> {
    ensure_idle(ctx)?;
    let previous = head_id(ctx)?;
    if previous.is_none() {
        return Err(YagguiError::invalid_argument(
            "There is no commit to apply them on yet.",
            "Il n'y a pas encore de commit sur lequel les appliquer.",
        ));
    }
    check_mainline(ctx.repo, commits, mainline, true)?;
    let mut command = ctx.command(["cherry-pick"]);
    if let Some(n) = mainline {
        command = command.arg("-m").arg(n.to_string());
    }
    for id in commits {
        command = command.arg(id.to_string());
    }
    run_op(ctx, HistoryOp::CherryPick, &command)?;
    result(ctx, previous, None)
}

fn revert(ctx: &WriteContext<'_>, request: &RevertRequest) -> Result<HistoryResult, YagguiError> {
    ensure_idle(ctx)?;
    let commit = resolve_commit(ctx.repo, rev_arg(&request.commit)?)?;
    check_mainline(ctx.repo, &[commit], request.mainline, false)?;
    let previous = head_id(ctx)?;
    let mut command = ctx.command(["revert", "--no-edit"]);
    if let Some(n) = request.mainline {
        command = command.arg("-m").arg(n.to_string());
    }
    let command = command.arg(commit.to_string());
    run_op(ctx, HistoryOp::Revert, &command)?;
    result(ctx, previous, None)
}

// --- Reset ------------------------------------------------------------------------------

/// What a hard reset to `target` loses, from `git status --porcelain=v1 -z` output.
pub(super) fn preview(
    repo: &gix::Repository,
    target: ObjectId,
    status: &str,
) -> Result<ResetPreview, YagguiError> {
    let tree = repo
        .find_commit(target)
        .and_then(|c| c.tree())
        .map_err(gix_err("read the target tree"))?;
    let in_target = |path: &str| -> Result<bool, YagguiError> {
        Ok(tree
            .lookup_entry_by_path(path)
            .map_err(gix_err("read the target tree"))?
            .is_some_and(|e| !e.mode().is_tree()))
    };
    let mut lost: BTreeMap<String, LostChange> = BTreeMap::new();
    let mut entries = status.split('\0').filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        let (Some(code), Some(path)) = (entry.get(..2), entry.get(3..)) else {
            continue;
        };
        let (x, y) = (code.as_bytes()[0], code.as_bytes()[1]);
        if code == "??" {
            if in_target(path)? {
                lost.insert(path.to_owned(), LostChange::Untracked);
            }
            continue;
        }
        if x == b'R' || x == b'C' {
            if let Some(source) = entries.next()
                && x == b'R'
                && in_target(source)?
            {
                lost.insert(source.to_owned(), LostChange::Deleted);
            }
            if !in_target(path)? {
                lost.insert(path.to_owned(), LostChange::Added);
            } else {
                lost.insert(path.to_owned(), LostChange::Modified);
            }
            continue;
        }
        let change = if x == b'A' && !in_target(path)? {
            LostChange::Added
        } else if (x == b'D' || y == b'D') && x != b'U' && y != b'U' {
            if !in_target(path)? {
                // Deleted here and absent from the target: nothing comes back.
                continue;
            }
            LostChange::Deleted
        } else {
            LostChange::Modified
        };
        lost.insert(path.to_owned(), change);
    }
    let head = repo.head_id().ok().map(gix::Id::detach);
    let branch = repo
        .head_name()
        .map_err(gix_err("read HEAD"))?
        .map(|n| n.shorten().to_string());
    let (behind, gained) = match head {
        Some(head) => (
            count_exclusive(repo, head, target)?,
            count_exclusive(repo, target, head)?,
        ),
        None => (0, 0),
    };
    Ok(ResetPreview {
        target: target.to_string(),
        branch,
        commits_left_behind: behind,
        commits_gained: gained,
        hard_lost: lost
            .into_iter()
            .map(|(path, change)| LostFile { path, change })
            .collect(),
    })
}

// --- Operation in progress --------------------------------------------------------------

fn current_operation(ctx: &WriteContext<'_>) -> Result<RepoOperation, YagguiError> {
    read_operation(ctx.repo).ok_or_else(YagguiError::no_operation)
}

/// Where the moved branch was before the operation started.
fn operation_start(ctx: &WriteContext<'_>) -> Result<Option<ObjectId>, YagguiError> {
    let git_dir = ctx.repo.path();
    for name in [
        "rebase-merge/orig-head",
        "rebase-apply/orig-head",
        "sequencer/head",
    ] {
        if let Some(id) = std::fs::read_to_string(git_dir.join(name))
            .ok()
            .and_then(|s| ObjectId::from_hex(s.trim().as_bytes()).ok())
        {
            return Ok(Some(id));
        }
    }
    head_id(ctx)
}

fn sequencer(operation: &RepoOperation) -> &'static str {
    match operation {
        RepoOperation::Rebase { .. } => "rebase",
        RepoOperation::CherryPick => "cherry-pick",
        RepoOperation::Revert => "revert",
        RepoOperation::ApplyMailbox => "am",
        RepoOperation::Merge { .. } => "merge",
        RepoOperation::Bisect => "bisect",
    }
}

fn history_op(operation: &RepoOperation) -> HistoryOp {
    match operation {
        RepoOperation::Rebase { .. } | RepoOperation::ApplyMailbox => HistoryOp::Rebase,
        RepoOperation::CherryPick => HistoryOp::CherryPick,
        RepoOperation::Revert => HistoryOp::Revert,
        RepoOperation::Merge { .. } | RepoOperation::Bisect => HistoryOp::Merge,
    }
}

/// Something is staged: the index differs from HEAD.
fn has_staged_changes(ctx: &WriteContext<'_>) -> Result<bool, YagguiError> {
    let run = raw(ctx, &ctx.command(["diff", "--cached", "--quiet", "--"]))?;
    match run.exit_code {
        Some(0) => Ok(false),
        Some(1) => Ok(true),
        _ => Err(classify(ctx, &run)),
    }
}

/// `--author` / `--date` of the commit a rebase stopped on (`rebase-merge/author-script`,
/// shell-quoted assignments).
fn rebase_author(ctx: &WriteContext<'_>) -> Option<(String, String)> {
    let script =
        std::fs::read_to_string(ctx.repo.path().join("rebase-merge/author-script")).ok()?;
    let mut values = BTreeMap::new();
    for line in script.lines() {
        let (key, value) = line.split_once('=')?;
        values.insert(key.trim(), unquote_sq(value.trim())?);
    }
    let name = values.get("GIT_AUTHOR_NAME")?;
    let email = values.get("GIT_AUTHOR_EMAIL")?;
    let date = values.get("GIT_AUTHOR_DATE")?;
    Some((format!("{name} <{email}>"), date.clone()))
}

/// The message a chain of `fixup` steps keeps (`rebase-merge/message-fixup`), when the
/// rebase stopped on one of them: HEAD is the commit they meld into (`amend`) and the chain
/// has no `squash` (whose message Git combines).
fn fixup_message(ctx: &WriteContext<'_>) -> Result<Option<String>, YagguiError> {
    let dir = ctx.repo.path().join("rebase-merge");
    let read = |name: &str| std::fs::read_to_string(dir.join(name)).ok();
    let (Some(fixups), Some(amend), Some(kept)) =
        (read("current-fixups"), read("amend"), read("message-fixup"))
    else {
        return Ok(None);
    };
    let only_fixups = fixups.lines().all(|line| {
        let mut words = line.split_whitespace();
        words.next() == Some("fixup") && words.next().is_some_and(|w| !w.starts_with('-'))
    });
    let head = head_id(ctx)?.map(|id| id.to_string());
    Ok((only_fixups && head.as_deref() == Some(amend.trim())).then_some(kept))
}

/// `'it'\''s'` → `it's`.
fn unquote_sq(value: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = value;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix('\'') {
            let end = after.find('\'')?;
            out.push_str(&after[..end]);
            rest = &after[end + 1..];
        } else {
            rest = rest.strip_prefix("\\'")?;
            out.push('\'');
        }
    }
    Some(out)
}

fn continue_operation(
    ctx: &WriteContext<'_>,
    message: Option<&str>,
) -> Result<HistoryResult, YagguiError> {
    let operation = current_operation(ctx)?;
    if operation == RepoOperation::Bisect {
        return Err(YagguiError::invalid_argument(
            "A bisect has nothing to continue: mark commits or end it.",
            "Un bisect n'a rien à continuer : marque des commits ou termine-le.",
        ));
    }
    if !unmerged_paths(ctx)?.is_empty() {
        return Err(YagguiError::unresolved_conflicts());
    }
    let previous = operation_start(ctx)?;
    let message = message_or(message);
    let op = history_op(&operation);
    match &operation {
        RepoOperation::Merge { .. } => {
            let prepared = operation::prepared_message(ctx.repo, &operation);
            let text = message
                .map(str::to_owned)
                .or(prepared)
                .unwrap_or_else(|| "Merge".to_owned());
            commit_with(ctx, &text)?;
        }
        RepoOperation::CherryPick | RepoOperation::Revert => {
            let stopped_on_pick = ["CHERRY_PICK_HEAD", "REVERT_HEAD"]
                .iter()
                .any(|name| ctx.repo.path().join(name).is_file());
            if stopped_on_pick {
                if !has_staged_changes(ctx)? {
                    let head = ["CHERRY_PICK_HEAD", "REVERT_HEAD"]
                        .iter()
                        .find_map(|name| std::fs::read_to_string(ctx.repo.path().join(name)).ok());
                    return Err(YagguiError::empty_commit(head.as_deref().map(str::trim)));
                }
                let prepared = operation::prepared_message(ctx.repo, &operation);
                let text = message
                    .map(str::to_owned)
                    .or(prepared)
                    .unwrap_or_else(|| "Apply changes".to_owned());
                commit_with(ctx, &text)?;
            }
            // Remaining commits of a multi-commit pick or revert.
            if read_operation(ctx.repo).is_some() {
                let command = ctx.command([sequencer(&operation), "--continue"]);
                run_op(ctx, op, &command)?;
            }
        }
        RepoOperation::Rebase { .. } => {
            if message.is_none()
                && let Some(kept) = fixup_message(ctx)?
                && has_staged_changes(ctx)?
            {
                // Stopped on a `fixup` step (interactive rebase, M3-4): Git would commit its
                // commented "combination" message with comments stripped, losing the lines
                // of the kept message that start with `#`. Amend with it verbatim instead,
                // as Git does without a conflict; the rebase then goes on.
                let command = ctx.command(["commit", "--amend", "--cleanup=verbatim", "-F", "-"]);
                ctx.run(&command.stdin(kept))?;
            }
            if let Some(message) = message
                && has_staged_changes(ctx)?
            {
                // The rebase would take its prepared message: commit first, with the
                // replayed commit's author, then let it go on.
                let mut command = ctx.command(["commit", "-F", "-"]);
                if let Some((author, date)) = rebase_author(ctx) {
                    command = command
                        .arg(format!("--author={author}"))
                        .arg(format!("--date={date}"));
                }
                let mut text = message.to_owned();
                text.push('\n');
                ctx.run(&command.stdin(text))?;
            }
            run_op(ctx, op, &ctx.command(["rebase", "--continue"]))?;
        }
        RepoOperation::ApplyMailbox => {
            run_op(ctx, op, &ctx.command(["am", "--continue"]))?;
        }
        RepoOperation::Bisect => {}
    }
    result(ctx, previous, None)
}

fn skip_operation(ctx: &WriteContext<'_>) -> Result<HistoryResult, YagguiError> {
    let operation = current_operation(ctx)?;
    if let RepoOperation::Merge { .. } = operation {
        return Err(YagguiError::invalid_argument(
            "A merge cannot skip a commit: continue or abort it.",
            "Un merge ne peut pas passer de commit : continue-le ou annule-le.",
        ));
    }
    let previous = operation_start(ctx)?;
    if operation == RepoOperation::Bisect {
        // A skip mark on HEAD: only skipped commits left is a result, not a failure.
        bisect_skip(ctx)?;
    } else {
        run_op(
            ctx,
            history_op(&operation),
            &ctx.command([sequencer(&operation), "--skip"]),
        )?;
    }
    result(ctx, previous, None)
}

fn abort_operation(ctx: &WriteContext<'_>) -> Result<(), YagguiError> {
    let operation = current_operation(ctx)?;
    let command = match operation {
        // A squash merge records no MERGE_HEAD: `merge --abort` refuses it.
        RepoOperation::Merge { squash: true } => ctx.command(["reset", "-q", "--merge"]),
        RepoOperation::Bisect => ctx.command(["bisect", "reset"]),
        _ => ctx.command([sequencer(&operation), "--abort"]),
    };
    ctx.run(&command).map(drop)
}

// --- Conflicts --------------------------------------------------------------------------

fn run_merge_tool(
    ctx: &WriteContext<'_>,
    path: String,
    preferred: Option<String>,
) -> Result<MergeToolResult, YagguiError> {
    let path = checked_paths(ctx.workdir, vec![path])?.remove(0);
    // Read here rather than passed by the front: only the user's configuration names the tool.
    let tool = preferred
        .or_else(|| operation::merge_tool(ctx.repo))
        .ok_or_else(YagguiError::merge_tool_missing)?;
    if !unmerged_paths(ctx)?.contains(&path) {
        return Err(YagguiError::invalid_argument(
            format!("\"{path}\" is not in conflict."),
            format!("« {path} » n'est pas en conflit."),
        ));
    }
    // `--no-prompt`: no "Hit return" question (stdin is empty anyway, so any other question
    // reads end of file and gives up). One argument for `--tool=`: never parsed as two.
    let command = ctx
        .command(["mergetool", "--no-prompt"])
        .arg(format!("--tool={tool}"))
        .arg("--")
        .arg(&path);
    let run = ctx.git.run_raw(&command, Some(ctx.cancel), None)?;
    let resolved = !unmerged_paths(ctx)?.contains(&path);
    if run.success || resolved {
        return Ok(MergeToolResult { resolved });
    }
    // Closed without saving: Git reports `merge of <path> failed`. Anything else means the
    // tool did not start.
    if run.stderr.contains("merge of ") && run.stderr.contains(" failed") {
        return Ok(MergeToolResult { resolved: false });
    }
    Err(YagguiError::merge_tool_failed(&tool).with_detail(&run.stderr))
}

fn resolve_conflicts(
    ctx: &WriteContext<'_>,
    paths: Vec<String>,
    resolution: &ConflictResolution,
) -> Result<(), YagguiError> {
    if paths.is_empty() {
        return Err(YagguiError::invalid_argument(
            "No file to resolve.",
            "Aucun fichier à résoudre.",
        ));
    }
    let paths = checked_paths(ctx.workdir, paths)?;
    let index = ctx.index()?;
    let stages = operation::conflict_stages(&index);
    drop(index);
    let mut checkout = Vec::new();
    let mut add = Vec::new();
    let mut remove = Vec::new();
    for path in &paths {
        let Some(stage) = stages.get(path) else {
            return Err(YagguiError::invalid_argument(
                format!("\"{path}\" is not in conflict."),
                format!("« {path} » n'est pas en conflit."),
            ));
        };
        let exists = std::fs::symlink_metadata(ctx.workdir.join(path)).is_ok();
        match resolution {
            ConflictResolution::Ours | ConflictResolution::Theirs => {
                let ours = matches!(resolution, ConflictResolution::Ours);
                let kept = if ours { stage.ours } else { stage.theirs };
                if kept.is_some() {
                    checkout.push(path.clone());
                } else {
                    remove.push(path.clone());
                }
            }
            ConflictResolution::MarkResolved if exists => add.push(path.clone()),
            ConflictResolution::MarkResolved => remove.push(path.clone()),
            ConflictResolution::Content { .. } => add.push(path.clone()),
        }
    }
    if let ConflictResolution::Content { content } = resolution {
        let [path] = paths.as_slice() else {
            return Err(YagguiError::invalid_argument(
                "Give exactly one file.",
                "Indique exactement un fichier.",
            ));
        };
        let full = ctx.workdir.join(path);
        if std::fs::symlink_metadata(&full).is_ok_and(|m| m.is_dir()) {
            return Err(YagguiError::invalid_argument(
                format!("\"{path}\" is a folder."),
                format!("« {path} » est un dossier."),
            ));
        }
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|err| {
                BackendError::io(format!("cannot create {}", parent.display()), err)
            })?;
        }
        std::fs::write(&full, content)
            .map_err(|err| BackendError::io(format!("cannot write {}", full.display()), err))?;
    }
    let side = match resolution {
        ConflictResolution::Theirs => "--theirs",
        _ => "--ours",
    };
    ctx.run_on_paths(&["checkout", side], &checkout)?;
    add.extend(checkout);
    ctx.run_on_paths(&["add", "-A"], &add)?;
    ctx.run_on_paths(&["rm", "-q", "-f", "--ignore-unmatch"], &remove)?;
    Ok(())
}

/// A continue or skip that succeeded but left a rebase in progress (halted on the next
/// `edit` of an interactive rebase) reads "paused", not "completed".
fn note_if_halted(ctx: &WriteContext<'_>) {
    if matches!(read_operation(ctx.repo), Some(RepoOperation::Rebase { .. })) {
        ctx.op.set_note(OpNote::Paused);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unquotes_author_script_values() {
        assert_eq!(
            unquote_sq("'yaggui Tests'").as_deref(),
            Some("yaggui Tests")
        );
        assert_eq!(unquote_sq("'O'\\''Brien'").as_deref(), Some("O'Brien"));
        assert_eq!(
            unquote_sq("'@1767268800 +0000'").as_deref(),
            Some("@1767268800 +0000")
        );
        assert_eq!(unquote_sq("unquoted"), None);
    }
}
