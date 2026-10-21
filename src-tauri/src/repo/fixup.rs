//! Fixup commits and autosquash (M7-3, F-147).
//!
//! A fixup is `git commit --fixup=<sha>`: Git writes the `fixup! <subject>` message itself,
//! the hooks run as for any commit, and the journal records it as a commit. Autosquash does
//! not run `git rebase --autosquash`: it gives the interactive rebase view (M3-4) a todo with
//! the fixups already under their targets, so the arrangement is reviewed before it runs.

use gix::ObjectId;

use crate::events::OpKind;
use crate::git::errors::{BackendError, YagguiError};
use crate::git::ops::rebase_todo::{self, Autosquash};
use crate::git::ops::types::{
    AutosquashPlan, CommitResult, JournalOp, REBASE_PLAN_MAX, RebaseAction, RebaseTodoEntry,
};
use crate::git::read::state::{count_exclusive, gix as gix_err};
use crate::graph::resolve_commit;

use super::RepoManager;
use super::history::{head_id, rev_arg};
use super::interactive::{branch_and_head, read_plan};
use super::journal::{Mode, Plan};
use super::write::{WriteContext, run_commit};

impl RepoManager {
    /// Commits the staged changes as `fixup! <subject of target>`. Undoable like a commit.
    pub fn commit_fixup(&self, repo_id: u32, target: String) -> Result<CommitResult, YagguiError> {
        self.journal_op(repo_id, OpKind::Commit, true, false, move |ctx| {
            let (result, summary) = commit_fixup(ctx, &target)?;
            let op = JournalOp::Commit {
                sha: result.sha.clone(),
                summary,
            };
            Ok((result, Some(Plan::new(op, Mode::Refs))))
        })
    }

    /// The interactive rebase plan of `base..HEAD` with its fixups under their targets.
    /// Without `base`, the plan starts at the parent of the oldest commit a fixup of the
    /// current branch targets; `None` when there is none.
    pub fn autosquash_plan(
        &self,
        repo_id: u32,
        base: Option<String>,
    ) -> Result<Option<AutosquashPlan>, YagguiError> {
        let repo = self.session(repo_id)?.repo()?.to_thread_local();
        read_autosquash(&repo, base.as_deref())
    }
}

fn commit_fixup(
    ctx: &WriteContext<'_>,
    target: &str,
) -> Result<(CommitResult, String), YagguiError> {
    let target = resolve_commit(ctx.repo, rev_arg(target)?)?;
    let Some(head) = head_id(ctx)? else {
        return Err(YagguiError::revision_not_found("HEAD"));
    };
    // A fixup is only squashed by a rebase of the branch that holds its target.
    if count_exclusive(ctx.repo, target, head)? != 0 {
        return Err(YagguiError::invalid_argument(
            "This commit is not on the current branch: check out its branch to create a fixup for it.",
            "Ce commit n'est pas sur la branche courante : bascule sur sa branche pour lui créer un fixup.",
        ));
    }
    let command = ctx.command(["commit".to_owned(), format!("--fixup={target}")]);
    let result = run_commit(ctx, command, false)?;
    let id = ObjectId::from_hex(result.sha.as_bytes())
        .map_err(|err| BackendError::Invariant(format!("HEAD is not an id: {err}")))?;
    let summary = summary_of(ctx.repo, id)?;
    Ok((result, summary))
}

fn summary_of(repo: &gix::Repository, id: ObjectId) -> Result<String, YagguiError> {
    let commit = repo.find_commit(id).map_err(gix_err("read a commit"))?;
    let decoded = commit.decode().map_err(gix_err("decode a commit"))?;
    Ok(decoded.message().summary().to_string())
}

fn read_autosquash(
    repo: &gix::Repository,
    base: Option<&str>,
) -> Result<Option<AutosquashPlan>, YagguiError> {
    let base = match base {
        Some(base) => base.to_owned(),
        None => match automatic_base(repo)? {
            Some(base) => base.to_string(),
            None => return Ok(None),
        },
    };
    let plan = read_plan(repo, &base)?;
    let ids = plan
        .commits
        .iter()
        .map(|commit| {
            ObjectId::from_hex(commit.sha.as_bytes())
                .map_err(|err| BackendError::Invariant(format!("plan sha is not an id: {err}")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let commits: Vec<_> = ids
        .iter()
        .zip(&plan.commits)
        .map(|(id, commit)| (*id, commit.summary.as_str()))
        .collect();
    let Autosquash { order, unmatched } = rebase_todo::autosquash(&commits);
    let todo: Vec<_> = order
        .iter()
        .map(|&(i, action)| RebaseTodoEntry {
            sha: plan.commits[i].sha.clone(),
            action,
            message: None,
        })
        .collect();
    let fixups = todo
        .iter()
        .filter(|entry| entry.action == RebaseAction::Fixup)
        .count();
    let unmatched = unmatched
        .into_iter()
        .map(|i| plan.commits[i].sha.clone())
        .collect();
    Ok(Some(AutosquashPlan {
        plan,
        todo,
        unmatched,
        fixups: u32::try_from(fixups).unwrap_or(u32::MAX),
    }))
}

/// Parent of the oldest commit a `fixup!` commit targets, among the last commits of the
/// branch that an interactive rebase can rewrite: first parents from HEAD, up to the first
/// merge or root commit (both excluded), at most `REBASE_PLAN_MAX`.
fn automatic_base(repo: &gix::Repository) -> Result<Option<ObjectId>, YagguiError> {
    let (_, head) = branch_and_head(repo)?;
    let mut chain: Vec<(ObjectId, String, ObjectId)> = Vec::new();
    let mut current = head;
    while chain.len() < REBASE_PLAN_MAX as usize {
        let commit = repo
            .find_commit(current)
            .map_err(gix_err("read a commit"))?;
        let decoded = commit.decode().map_err(gix_err("decode a commit"))?;
        let mut parents = decoded.parents();
        let (Some(parent), None) = (parents.next(), parents.next()) else {
            break;
        };
        chain.push((current, decoded.message().summary().to_string(), parent));
        current = parent;
    }
    chain.reverse();
    let commits: Vec<_> = chain.iter().map(|(id, s, _)| (*id, s.as_str())).collect();
    Ok(rebase_todo::autosquash(&commits)
        .oldest_target()
        .map(|i| chain[i].2))
}
