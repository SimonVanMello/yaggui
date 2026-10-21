//! Graph, diff and branch tools of M4-7b: graph filter (F-028), merge-base jump (F-030),
//! comparison of two revisions (F-029, F-104), image diff (F-085), external diff tool
//! (F-087) and cleanup of merged / `[gone]` branches (F-105).

use std::collections::BTreeSet;

use gix::ObjectId;
use gix::bstr::ByteSlice;

use crate::events::OpKind;
use crate::git::cli::GitCommand;
use crate::git::errors::{BackendError, YagguiError};
use crate::git::ops::types::{
    BranchCleanup, CleanupBranch, DeleteBranchesResult, DeletedRef, JOURNAL_PATHS_MAX, JournalOp,
    is_protected_branch,
};
use crate::git::read::diff::{
    self,
    types::{DiffSide, DiffTarget},
};
use crate::git::read::refs::{self, RepoRefs};
use crate::git::read::state::{HeadState, count_exclusive};
use crate::graph::types::{
    COMPARE_MAX_COMMITS, ComparedCommit, Comparison, GRAPH_FILTER_MAX, GraphFilter, GraphLocation,
};
use crate::graph::{Snapshot, decode_row, resolve_commit};

use super::journal::{Mode, Plan};
use super::ref_ops::{current_branch, find_ref};
use super::write::{WriteContext, checked_paths};
use super::{RepoManager, lock};

impl RepoManager {
    pub fn graph_filter(&self, repo_id: u32) -> Result<GraphFilter, YagguiError> {
        Ok(self.session(repo_id)?.graph.filter())
    }

    /// Stores the filter of the repository and applies it: the next graph page is computed
    /// without the hidden refs. Returns the filter as stored (names deduplicated).
    pub fn set_graph_filter(
        &self,
        repo_id: u32,
        filter: GraphFilter,
    ) -> Result<GraphFilter, YagguiError> {
        let filter = normalized_filter(filter)?;
        let session = self.session(repo_id)?;
        self.store.set_graph_filter(repo_id, &filter)?;
        session.graph.set_filter(filter.clone());
        Ok(filter)
    }

    /// Best common ancestor of two revisions and its row (F-030); `None` for unrelated
    /// histories.
    pub fn merge_base(
        &self,
        repo_id: u32,
        a: &str,
        b: &str,
    ) -> Result<Option<GraphLocation>, YagguiError> {
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        let (a, b) = (resolve_commit(&repo, a)?, resolve_commit(&repo, b)?);
        let Some(base) = merge_base_of(&repo, a, b)? else {
            return Ok(None);
        };
        session.read_graph(&repo, |snapshot| {
            Ok(Some(GraphLocation {
                version: snapshot.version,
                sha: base.to_string(),
                // Can walk far down the history: the jump waits for it (`graph-progress`).
                row: snapshot.find_row(&repo.objects, &base)?,
            }))
        })
    }

    /// Commits of `a` not in `b` and the reverse (F-104), with their merge-base.
    pub fn compare(&self, repo_id: u32, a: &str, b: &str) -> Result<Comparison, YagguiError> {
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        let (a, b) = (resolve_commit(&repo, a)?, resolve_commit(&repo, b)?);
        let snapshot = session.snapshot(&repo)?;
        let (only_a, only_a_count) = exclusive_commits(&repo, &snapshot, a, b)?;
        let (only_b, only_b_count) = exclusive_commits(&repo, &snapshot, b, a)?;
        Ok(Comparison {
            a: a.to_string(),
            b: b.to_string(),
            merge_base: merge_base_of(&repo, a, b)?.map(|id| id.to_string()),
            only_a,
            only_b,
            only_a_count,
            only_b_count,
            version: snapshot.version,
        })
    }

    /// One side of an image diff as a `data:` URL (F-085). Read-only.
    pub fn diff_image(
        &self,
        repo_id: u32,
        target: &DiffTarget,
        path: &str,
        old_path: Option<&str>,
        side: DiffSide,
    ) -> Result<Option<String>, YagguiError> {
        let repo = self.session(repo_id)?.repo()?.to_thread_local();
        diff::image(&repo, target, path, old_path, side)
    }

    /// Opens `path` of `target` in the external diff tool with `git difftool` (F-087) and
    /// waits for the tool to close. Read-only: it does not take the repository's queue, so
    /// the repository stays usable while the tool is open. Returns the tool's name.
    pub fn run_diff_tool(
        &self,
        repo_id: u32,
        target: &DiffTarget,
        path: &str,
        old_path: Option<&str>,
    ) -> Result<String, YagguiError> {
        let session = self.session(repo_id)?;
        let mut paths = vec![path.to_owned()];
        if let Some(old) = old_path.filter(|old| *old != path) {
            paths.push(old.to_owned());
        }
        let paths = checked_paths(&session.workdir, paths)?;
        let repo = session.repo()?.to_thread_local();
        let preferred = self.store.preferences()?.diff_tool;
        let (tool, gui) = diff_tool(&repo, preferred).ok_or_else(YagguiError::diff_tool_missing)?;
        let mut command = GitCommand::new(["difftool", "--no-prompt"])
            .cwd(&session.workdir)
            .repo(repo_id);
        command = match &tool {
            Some(tool) => command.arg(format!("--tool={tool}")),
            None => command.arg("--gui"),
        };
        for rev in revisions(&repo, target)? {
            command = command.arg(rev);
        }
        command = command.arg("--");
        for path in &paths {
            command = command.arg(path);
        }
        let name = tool.or(gui).unwrap_or_default();
        let run = self.git.run_raw(&command, None, None)?;
        if !run.success {
            return Err(YagguiError::diff_tool_failed(&name).with_detail(&run.stderr));
        }
        Ok(name)
    }

    /// Merged and `[gone]` local branches the cleanup offers (F-105). Never the current
    /// branch, a branch checked out in a worktree, nor a protected one.
    pub fn branch_cleanup(&self, repo_id: u32) -> Result<BranchCleanup, YagguiError> {
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        let protected = self.store.preferences()?.protected_branches;
        let refs = refs::read_refs(&repo, &mut lock(&session.refs_cache))?;
        cleanup_of(&repo, &refs, &protected)
    }

    /// Deletes local branches only (`git branch -D`), after the same checks as the
    /// cleanup listing; journaled as one operation (undo restores every branch).
    pub fn delete_branches(
        &self,
        repo_id: u32,
        names: Vec<String>,
    ) -> Result<DeleteBranchesResult, YagguiError> {
        let protected = self.store.preferences()?.protected_branches;
        let session = self.session(repo_id)?;
        self.journal_op(repo_id, OpKind::Branch, false, false, move |ctx| {
            let checked_out = {
                let refs = refs::read_refs(ctx.repo, &mut lock(&session.refs_cache))?;
                checked_out_branches(&refs)
            };
            let result = delete_branches(ctx, &names, &protected, &checked_out)?;
            let count = u32::try_from(result.deleted.len()).unwrap_or(u32::MAX);
            let op = JournalOp::DeleteBranches {
                names: names
                    .iter()
                    .take(JOURNAL_PATHS_MAX as usize)
                    .cloned()
                    .collect(),
                count,
            };
            Ok((result, Some(Plan::new(op, Mode::Refs))))
        })
    }
}

fn normalized_filter(filter: GraphFilter) -> Result<GraphFilter, YagguiError> {
    let valid = |name: &str| {
        (name.starts_with("refs/heads/")
            || name.starts_with("refs/remotes/")
            || name.starts_with("refs/tags/"))
            && gix::refs::FullName::try_from(name).is_ok()
    };
    let mut seen = BTreeSet::new();
    let mut hidden = Vec::new();
    for name in filter.hidden {
        let name = name.trim().to_owned();
        if !valid(&name) {
            return Err(invalid_ref(&name));
        }
        if seen.insert(name.clone()) {
            hidden.push(name);
        }
    }
    if hidden.len() > GRAPH_FILTER_MAX as usize {
        return Err(YagguiError::invalid_argument(
            format!("At most {GRAPH_FILTER_MAX} branches can be hidden."),
            format!("{GRAPH_FILTER_MAX} branches au plus peuvent être masquées."),
        ));
    }
    let solo = match filter.solo.map(|s| s.trim().to_owned()) {
        Some(solo) if !valid(&solo) => return Err(invalid_ref(&solo)),
        solo => solo,
    };
    Ok(GraphFilter {
        hidden,
        solo,
        hide_remotes: filter.hide_remotes,
        hide_stashes: filter.hide_stashes,
        first_parent: filter.first_parent,
    })
}

fn invalid_ref(name: &str) -> YagguiError {
    YagguiError::invalid_argument(
        format!("\"{name}\" is not a branch or tag name."),
        format!("« {name} » n'est pas un nom de branche ou de tag."),
    )
}

fn merge_base_of(
    repo: &gix::Repository,
    a: ObjectId,
    b: ObjectId,
) -> Result<Option<ObjectId>, YagguiError> {
    if a == b {
        return Ok(Some(a));
    }
    match repo.merge_base(a, b) {
        Ok(base) => Ok(base.map(gix::Id::detach)),
        Err(err) => Err(BackendError::gix("find the merge-base", err).into()),
    }
}

/// Commits reachable from `tip` and not from `hidden`, newest first: the first
/// `COMPARE_MAX_COMMITS` and the total.
fn exclusive_commits(
    repo: &gix::Repository,
    snapshot: &Snapshot,
    tip: ObjectId,
    hidden: ObjectId,
) -> Result<(Vec<ComparedCommit>, u32), YagguiError> {
    if tip == hidden {
        return Ok((Vec::new(), 0));
    }
    let walk = repo
        .rev_walk([tip])
        .with_hidden([hidden])
        .sorting(gix::revision::walk::Sorting::ByCommitTime(
            Default::default(),
        ))
        .all()
        .map_err(|err| BackendError::gix("walk history", err))?;
    let mut commits = Vec::new();
    let mut count = 0u32;
    let mut buf = Vec::new();
    for info in walk {
        let info = info.map_err(|err| BackendError::gix("walk history", err))?;
        count = count.saturating_add(1);
        if commits.len() < COMPARE_MAX_COMMITS as usize {
            let row = decode_row(&repo.objects, &info.id, &mut buf)?;
            commits.push(ComparedCommit {
                sha: info.id.to_string(),
                summary: row.summary,
                author_name: row.author_name,
                author_email: row.author_email,
                author_time: row.author_time,
                row: snapshot.row_of(&info.id),
            });
        }
    }
    Ok((commits, count))
}

/// Tool name for `--tool=` (`None`: `--gui`, from `diff.guitool`) and the name to show.
/// `None` when nothing is configured: `git difftool` would fall back to a terminal tool.
fn diff_tool(
    repo: &gix::Repository,
    preferred: Option<String>,
) -> Option<(Option<String>, Option<String>)> {
    if let Some(tool) = preferred {
        return Some((Some(tool), None));
    }
    let config = repo.config_snapshot();
    let read = |key: &str| {
        config
            .string(key)
            .map(|v| v.to_str_lossy().trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    if let Some(tool) = read("diff.tool") {
        return Some((Some(tool), None));
    }
    read("diff.guitool").map(|gui| (None, Some(gui)))
}

/// The revisions `git difftool` compares for `target`, as full SHAs (never parsed as
/// options).
fn revisions(repo: &gix::Repository, target: &DiffTarget) -> Result<Vec<String>, YagguiError> {
    Ok(match target {
        DiffTarget::Unstaged => Vec::new(),
        DiffTarget::Staged => vec!["--cached".to_owned()],
        DiffTarget::Commits { from, to } => {
            let to = repo
                .find_commit(resolve_commit(repo, to)?)
                .map_err(|err| BackendError::gix("read a commit", err))?;
            let from = match from {
                Some(from) => resolve_commit(repo, from)?.to_string(),
                None => match to.parent_ids().next() {
                    Some(parent) => parent.to_string(),
                    // Root commit: against the empty tree.
                    None => repo.empty_tree().id.to_string(),
                },
            };
            vec![from, to.id.to_string()]
        }
    })
}

/// Branches checked out in this worktree or another one.
fn checked_out_branches(refs: &RepoRefs) -> BTreeSet<String> {
    let mut names: BTreeSet<String> = refs
        .worktrees
        .iter()
        .filter_map(|w| match &w.head {
            Some(HeadState::Branch { name, .. } | HeadState::Unborn { name }) => Some(name.clone()),
            _ => None,
        })
        .collect();
    if let HeadState::Branch { name, .. } | HeadState::Unborn { name } = &refs.head {
        names.insert(name.clone());
    }
    names
}

fn cleanup_of(
    repo: &gix::Repository,
    refs: &RepoRefs,
    protected: &[String],
) -> Result<BranchCleanup, YagguiError> {
    let head = match &refs.head {
        HeadState::Branch { oid, .. } | HeadState::Detached { oid } => {
            ObjectId::from_hex(oid.as_bytes()).ok()
        }
        HeadState::Unborn { .. } => None,
    };
    let into = match &refs.head {
        HeadState::Branch { name, .. } => Some(name.clone()),
        _ => None,
    };
    let checked_out = checked_out_branches(refs);
    let mut cleanup = BranchCleanup {
        into,
        branches: Vec::new(),
        protected: Vec::new(),
        checked_out: Vec::new(),
    };
    for branch in &refs.local {
        let Ok(tip) = ObjectId::from_hex(branch.sha.as_bytes()) else {
            continue;
        };
        let gone = branch.upstream.as_ref().is_some_and(|u| u.gone);
        let merged = match head {
            Some(head) => tip == head || merge_base_of(repo, tip, head)? == Some(tip),
            None => false,
        };
        if !merged && !gone {
            continue;
        }
        if checked_out.contains(&branch.name) {
            cleanup.checked_out.push(branch.name.clone());
            continue;
        }
        if is_protected_branch(&branch.name, protected) {
            cleanup.protected.push(branch.name.clone());
            continue;
        }
        let unmerged = match (merged, head) {
            (false, Some(head)) => count_exclusive(repo, tip, head)?,
            (false, None) => count_exclusive_all(repo, tip)?,
            (true, _) => 0,
        };
        cleanup.branches.push(CleanupBranch {
            name: branch.name.clone(),
            sha: branch.sha.clone(),
            merged,
            gone,
            upstream: branch.upstream.as_ref().map(|u| u.name.clone()),
            unmerged,
        });
    }
    Ok(cleanup)
}

/// Commits reachable from `tip` (no HEAD commit to compare with).
fn count_exclusive_all(repo: &gix::Repository, tip: ObjectId) -> Result<u32, YagguiError> {
    let walk = repo
        .rev_walk([tip])
        .all()
        .map_err(|err| BackendError::gix("walk history", err))?;
    let mut count = 0u32;
    for info in walk {
        info.map_err(|err| BackendError::gix("walk history", err))?;
        count = count.saturating_add(1);
    }
    Ok(count)
}

fn delete_branches(
    ctx: &WriteContext<'_>,
    names: &[String],
    protected: &[String],
    checked_out: &BTreeSet<String>,
) -> Result<DeleteBranchesResult, YagguiError> {
    if names.is_empty() {
        return Err(YagguiError::invalid_argument(
            "No branch to delete.",
            "Aucune branche à supprimer.",
        ));
    }
    let current = current_branch(ctx.repo)?;
    let mut deleted = Vec::new();
    let mut seen = BTreeSet::new();
    // Everything is checked before the first deletion: a refusal deletes nothing.
    for name in names {
        if !seen.insert(name.as_str()) {
            continue;
        }
        if name.starts_with('-') {
            return Err(YagguiError::revision_not_found(name));
        }
        let full_name = format!("refs/heads/{name}");
        let sha =
            find_ref(ctx.repo, &full_name)?.ok_or_else(|| YagguiError::revision_not_found(name))?;
        if current.as_deref() == Some(name.as_str()) {
            return Err(YagguiError::current_branch(name));
        }
        if checked_out.contains(name) {
            return Err(YagguiError::branch_checked_out(name));
        }
        if is_protected_branch(name, protected) {
            return Err(YagguiError::protected_branch_delete(name));
        }
        deleted.push(DeletedRef {
            full_name,
            sha: sha.to_string(),
        });
    }
    let mut command = ctx.command(["branch", "-D", "--"]);
    for name in &seen {
        command = command.arg(name);
    }
    ctx.run(&command)?;
    Ok(DeleteBranchesResult { deleted })
}
