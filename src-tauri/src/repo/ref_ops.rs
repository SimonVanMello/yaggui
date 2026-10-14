//! Branch, checkout, stash and tag services of `RepoManager` (M2-3). Every write runs on the
//! repository's `OpQueue` and goes through `git/cli.rs`; ref names are checked with
//! `git check-ref-format` before use, and passed after `--` where the command accepts it.

use std::collections::BTreeSet;

use gix::ObjectId;

use crate::events::OpKind;
use crate::git::cli::{GitCli, GitCommand, GitRun};
use crate::git::errors::{BackendError, YagguiError, classify_git_failure};
use crate::git::ops::types::{
    BranchStart, CheckoutMode, CheckoutResult, CheckoutTarget, CreateTagRequest,
    DeleteBranchRequest, DeleteBranchResult, DeletedRef, JournalOp, RefNameKind, StashEntryInfo,
    StashId, StashPushRequest, UndoBlock,
};
use crate::git::read::refs::read_stashes;
use crate::graph::resolve_commit;

use super::RepoManager;
use super::journal::{Mode, Plan};
use super::write::WriteContext;

impl RepoManager {
    pub fn validate_ref_name(
        &self,
        repo_id: u32,
        kind: RefNameKind,
        name: &str,
    ) -> Result<(), YagguiError> {
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        // Called on every keystroke of a name field: validated in process, so the command
        // log only shows commands that change something. The operation itself still asks
        // `git check-ref-format`.
        check_ref_name(kind, name)?;
        ensure_absent(&repo, kind, name)
    }

    pub fn checkout(
        &self,
        repo_id: u32,
        target: CheckoutTarget,
        mode: CheckoutMode,
    ) -> Result<CheckoutResult, YagguiError> {
        self.journal_op(repo_id, OpKind::Checkout, false, false, move |ctx| {
            let result = checkout(ctx, &target, mode)?;
            let sha = ctx
                .repo
                .head_id()
                .map_err(|e| BackendError::gix("read HEAD", e))?
                .to_string();
            let op = JournalOp::Checkout {
                branch: result.branch.clone(),
                sha,
            };
            Ok((result, Some(Plan::new(op, Mode::Switch))))
        })
    }

    pub fn create_branch(
        &self,
        repo_id: u32,
        name: &str,
        from: BranchStart,
        checkout: bool,
    ) -> Result<(), YagguiError> {
        let name = name.to_owned();
        let kind = match from {
            BranchStart::Stash { .. } => OpKind::Stash,
            _ => OpKind::Branch,
        };
        self.journal_op(repo_id, kind, false, false, move |ctx| {
            create_branch(ctx, &name, &from, checkout)?;
            // A branch made from a stash also applies and drops it: not undoable.
            let plan = (!matches!(from, BranchStart::Stash { .. })).then(|| {
                let mode = if checkout { Mode::Switch } else { Mode::Refs };
                Plan::new(JournalOp::CreateBranch { name }, mode)
            });
            Ok(((), plan))
        })
    }

    pub fn rename_branch(
        &self,
        repo_id: u32,
        name: &str,
        new_name: &str,
    ) -> Result<(), YagguiError> {
        let (name, new_name) = (name.to_owned(), new_name.to_owned());
        self.journal_op(repo_id, OpKind::Branch, false, false, move |ctx| {
            existing_branch(ctx, &name)?;
            if new_name != name && new_name.eq_ignore_ascii_case(&name) {
                // Case-only rename: on a case-insensitive file system the new name "exists"
                // (it is the same loose ref file); Git handles it.
                check_ref_format(
                    ctx.git,
                    ctx.workdir,
                    ctx.repo_id,
                    RefNameKind::Branch,
                    &new_name,
                )?;
            } else {
                check_new_name(ctx, RefNameKind::Branch, &new_name)?;
            }
            ctx.run(&ctx.command(["branch", "-m", "--", &name, &new_name]))?;
            let op = JournalOp::RenameBranch {
                from: name.clone(),
                to: new_name.clone(),
            };
            let mode = Mode::Rename {
                from: name,
                to: new_name,
            };
            Ok(((), Some(Plan::new(op, mode))))
        })
    }

    pub fn delete_branch(
        &self,
        repo_id: u32,
        request: DeleteBranchRequest,
    ) -> Result<DeleteBranchResult, YagguiError> {
        let cancellable = request.delete_remote;
        self.journal_op(repo_id, OpKind::Branch, cancellable, false, move |ctx| {
            let result = delete_branch(ctx, &request)?;
            let remote = result.remote.is_some();
            let op = JournalOp::DeleteBranch {
                name: request.name.clone(),
                remote,
            };
            let plan = if remote {
                Plan::blocked(op, UndoBlock::Published)
            } else {
                Plan::new(op, Mode::Refs)
            };
            Ok((result, Some(plan)))
        })
    }

    pub fn set_upstream(
        &self,
        repo_id: u32,
        branch: &str,
        upstream: &str,
    ) -> Result<(), YagguiError> {
        let (branch, upstream) = (branch.to_owned(), upstream.to_owned());
        self.write_op(repo_id, OpKind::Branch, false, move |ctx| {
            existing_branch(ctx, &branch)?;
            let full = format!("refs/remotes/{upstream}");
            if upstream.starts_with('-') || find_ref(ctx.repo, &full)?.is_none() {
                return Err(YagguiError::revision_not_found(&upstream));
            }
            ctx.run(&ctx.command([
                "branch".to_owned(),
                format!("--set-upstream-to={full}"),
                "--".to_owned(),
                branch,
            ]))
            .map(drop)
        })
    }

    pub fn unset_upstream(&self, repo_id: u32, branch: &str) -> Result<(), YagguiError> {
        let branch = branch.to_owned();
        self.write_op(repo_id, OpKind::Branch, false, move |ctx| {
            existing_branch(ctx, &branch)?;
            if upstream_of(ctx, &branch)? == (None, None) {
                return Ok(());
            }
            ctx.run(&ctx.command(["branch", "--unset-upstream", "--", &branch]))
                .map(drop)
        })
    }

    pub fn stash_push(
        &self,
        repo_id: u32,
        request: StashPushRequest,
    ) -> Result<StashEntryInfo, YagguiError> {
        self.write_op(repo_id, OpKind::Stash, false, move |ctx| {
            stash_push(ctx, &request)
        })
    }

    pub fn stash_apply(&self, repo_id: u32, stash: StashId) -> Result<(), YagguiError> {
        self.write_op(repo_id, OpKind::Stash, false, move |ctx| {
            let entry = verify_stash(ctx, &stash)?;
            apply_stash(ctx, &stash, &entry, false, false, false).map(drop)
        })
    }

    pub fn stash_pop(&self, repo_id: u32, stash: StashId) -> Result<StashEntryInfo, YagguiError> {
        self.write_op(repo_id, OpKind::Stash, false, move |ctx| {
            let entry = verify_stash(ctx, &stash)?;
            apply_stash(ctx, &stash, &entry, true, false, false)
        })
    }

    pub fn stash_drop(&self, repo_id: u32, stash: StashId) -> Result<StashEntryInfo, YagguiError> {
        self.journal_op(repo_id, OpKind::Stash, false, false, move |ctx| {
            let entry = verify_stash(ctx, &stash)?;
            ctx.run(&ctx.command(["stash", "drop", "-q", &stash_ref(stash.index)]))?;
            let sha =
                ObjectId::from_hex(entry.sha.as_bytes()).map_err(|_| YagguiError::stale_refs())?;
            let op = JournalOp::StashDrop {
                message: entry.message.clone(),
            };
            let mode = Mode::StashDrop {
                sha,
                message: entry.message.clone(),
            };
            Ok((entry, Some(Plan::new(op, mode))))
        })
    }

    pub fn stash_rename(
        &self,
        repo_id: u32,
        stash: StashId,
        message: &str,
    ) -> Result<StashEntryInfo, YagguiError> {
        let message = message.trim().to_owned();
        self.write_op(repo_id, OpKind::Stash, false, move |ctx| {
            if message.is_empty() {
                return Err(YagguiError::invalid_argument(
                    "The stash message is empty.",
                    "Le message du stash est vide.",
                ));
            }
            let entry = verify_stash(ctx, &stash)?;
            // Store first: if the drop then fails, the stash is listed twice, never lost.
            ctx.run(&ctx.command([
                "stash".to_owned(),
                "store".to_owned(),
                "-q".to_owned(),
                format!("--message={message}"),
                entry.sha.clone(),
            ]))?;
            ctx.run(&ctx.command(["stash", "drop", "-q", &stash_ref(stash.index + 1)]))?;
            Ok(StashEntryInfo {
                sha: entry.sha,
                message,
            })
        })
    }

    pub fn stash_branch(
        &self,
        repo_id: u32,
        stash: StashId,
        name: &str,
    ) -> Result<(), YagguiError> {
        let name = name.to_owned();
        self.write_op(repo_id, OpKind::Stash, false, move |ctx| {
            stash_branch(ctx, &stash, &name)
        })
    }

    pub fn create_tag(&self, repo_id: u32, request: CreateTagRequest) -> Result<(), YagguiError> {
        // Signing may wait on a passphrase prompt (pinentry): let the user cancel it.
        let cancellable = request.sign;
        self.journal_op(repo_id, OpKind::Tag, cancellable, false, move |ctx| {
            create_tag(ctx, &request)?;
            let op = JournalOp::CreateTag { name: request.name };
            Ok(((), Some(Plan::new(op, Mode::Refs))))
        })
    }

    pub fn delete_tag(&self, repo_id: u32, name: &str) -> Result<DeletedRef, YagguiError> {
        let name = name.to_owned();
        self.journal_op(repo_id, OpKind::Tag, false, false, move |ctx| {
            let full_name = format!("refs/tags/{name}");
            let sha = match find_ref(ctx.repo, &full_name)? {
                Some(id) if !name.starts_with('-') => id,
                _ => return Err(YagguiError::revision_not_found(&name)),
            };
            ctx.run(&ctx.command(["tag", "-d", "--", &name]))?;
            let deleted = DeletedRef {
                full_name,
                sha: sha.to_string(),
            };
            let op = JournalOp::DeleteTag { name };
            Ok((deleted, Some(Plan::new(op, Mode::Refs))))
        })
    }
}

// --- Names and refs ---------------------------------------------------------------------

/// The rules of `git check-ref-format --branch` / `refs/tags/<name>`, without running git.
fn check_ref_name(kind: RefNameKind, name: &str) -> Result<(), YagguiError> {
    let tag = kind == RefNameKind::Tag;
    if name.is_empty() || name.starts_with('-') || name.contains("@{") || name == "HEAD" {
        return Err(YagguiError::invalid_ref_name(name, tag));
    }
    let full = ref_full_name(kind, name);
    let valid = if tag {
        gix::validate::reference::name(full.as_str().into()).is_ok()
    } else {
        gix::validate::reference::branch_name(full.as_str().into()).is_ok()
    };
    if valid {
        Ok(())
    } else {
        Err(YagguiError::invalid_ref_name(name, tag))
    }
}

/// `git check-ref-format` on a branch (`--branch`) or tag name. `@{-n}` and other syntaxes
/// that `--branch` expands are refused: the name must be used literally.
fn check_ref_format(
    git: &GitCli,
    workdir: &std::path::Path,
    repo_id: u32,
    kind: RefNameKind,
    name: &str,
) -> Result<(), YagguiError> {
    let tag = kind == RefNameKind::Tag;
    let invalid = || YagguiError::invalid_ref_name(name, tag);
    if name.is_empty() || name.starts_with('-') || name.contains("@{") || name == "HEAD" {
        return Err(invalid());
    }
    let command = match kind {
        RefNameKind::Branch => GitCommand::new(["check-ref-format", "--branch", name]),
        RefNameKind::Tag => {
            GitCommand::new(["check-ref-format".to_owned(), format!("refs/tags/{name}")])
        }
    };
    let run = git.run_raw(&command.cwd(workdir).repo(repo_id), None, None)?;
    let printed = run.stdout.trim_end_matches(['\n', '\r']);
    if run.success && (tag || printed == name) {
        Ok(())
    } else {
        Err(invalid())
    }
}

fn ref_full_name(kind: RefNameKind, name: &str) -> String {
    match kind {
        RefNameKind::Branch => format!("refs/heads/{name}"),
        RefNameKind::Tag => format!("refs/tags/{name}"),
    }
}

/// What `full_name` points to (not peeled), `None` when it does not exist.
pub(super) fn find_ref(
    repo: &gix::Repository,
    full_name: &str,
) -> Result<Option<ObjectId>, YagguiError> {
    let Ok(name) = gix::refs::FullName::try_from(full_name) else {
        return Ok(None);
    };
    let reference = repo
        .try_find_reference(&name)
        .map_err(|e| BackendError::gix("find a reference", e))?;
    Ok(reference.and_then(|r| r.target().try_id().map(ToOwned::to_owned)))
}

fn ensure_absent(repo: &gix::Repository, kind: RefNameKind, name: &str) -> Result<(), YagguiError> {
    if find_ref(repo, &ref_full_name(kind, name))?.is_some() {
        return Err(YagguiError::ref_exists(name, kind == RefNameKind::Tag));
    }
    Ok(())
}

pub(super) fn check_new_name(
    ctx: &WriteContext<'_>,
    kind: RefNameKind,
    name: &str,
) -> Result<(), YagguiError> {
    check_ref_format(ctx.git, ctx.workdir, ctx.repo_id, kind, name)?;
    ensure_absent(ctx.repo, kind, name)
}

/// The commit a local branch points to; `revisionNotFound` for a missing or malformed name.
pub(super) fn existing_branch(ctx: &WriteContext<'_>, name: &str) -> Result<ObjectId, YagguiError> {
    if name.starts_with('-') {
        return Err(YagguiError::revision_not_found(name));
    }
    find_ref(ctx.repo, &format!("refs/heads/{name}"))?
        .ok_or_else(|| YagguiError::revision_not_found(name))
}

/// Short name of the checked out branch, `None` when detached.
pub(super) fn current_branch(repo: &gix::Repository) -> Result<Option<String>, YagguiError> {
    let head = repo
        .head_name()
        .map_err(|e| BackendError::gix("read HEAD", e))?;
    Ok(head.map(|name| name.shorten().to_string()))
}

/// `branch.<name>.remote` and `.merge`, read with `git config` (the session's config
/// snapshot may predate a change made outside yaggui).
pub(super) fn upstream_of(
    ctx: &WriteContext<'_>,
    branch: &str,
) -> Result<(Option<String>, Option<String>), YagguiError> {
    let get = |key: String| -> Result<Option<String>, YagguiError> {
        let run = ctx.git.run_raw(
            &ctx.command(["config", "--get", &key]),
            Some(ctx.cancel),
            None,
        )?;
        let value = run.stdout.trim_end_matches(['\n', '\r']).to_owned();
        Ok((run.success && !value.is_empty()).then_some(value))
    };
    Ok((
        get(format!("branch.{branch}.remote"))?,
        get(format!("branch.{branch}.merge"))?,
    ))
}

// --- Working tree -----------------------------------------------------------------------

/// Paths of `git status`: tracked changes (staged, unstaged, unmerged) and untracked files.
pub(super) struct WorktreeStatus {
    pub(super) tracked: BTreeSet<String>,
    pub(super) untracked: BTreeSet<String>,
    pub(super) unmerged: bool,
}

pub(super) fn worktree_status(ctx: &WriteContext<'_>) -> Result<WorktreeStatus, YagguiError> {
    let out = ctx.run(&ctx.command([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=dirty",
    ]))?;
    let mut status = WorktreeStatus {
        tracked: BTreeSet::new(),
        untracked: BTreeSet::new(),
        unmerged: false,
    };
    let mut entries = out.stdout.split('\0').filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        let (Some(code), Some(path)) = (entry.get(..2), entry.get(3..)) else {
            continue;
        };
        if code == "??" {
            status.untracked.insert(path.to_owned());
            continue;
        }
        if matches!(code, "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU") {
            status.unmerged = true;
        }
        if code.contains('R') || code.contains('C') {
            // The source path follows as its own entry.
            if let Some(source) = entries.next() {
                status.tracked.insert(source.to_owned());
            }
        }
        status.tracked.insert(path.to_owned());
    }
    Ok(status)
}

/// Files whose content differs between HEAD and `target` (what a checkout rewrites).
fn changed_between_head_and(
    ctx: &WriteContext<'_>,
    target: &str,
) -> Result<BTreeSet<String>, YagguiError> {
    let out = ctx.run(&ctx.command([
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        "HEAD",
        target,
        "--",
    ]))?;
    Ok(out
        .stdout
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect())
}

/// Files listed under "would be overwritten" (tracked or untracked) in a refusal from Git.
pub(super) fn overwritten_paths(stderr: &str) -> Option<Vec<String>> {
    let mut paths = Vec::new();
    let mut listing = false;
    let mut found = false;
    for line in stderr.lines() {
        if line.contains("would be overwritten by")
            || line.contains("would be removed by")
            || line.contains("would lose untracked files")
        {
            listing = true;
            found = true;
        } else if listing && line.starts_with('\t') {
            paths.push(line.trim().to_owned());
        } else {
            listing = false;
        }
    }
    found.then_some(paths)
}

/// Conflicted paths of the index, after a stash apply.
pub(super) fn unmerged_paths(ctx: &WriteContext<'_>) -> Result<Vec<String>, YagguiError> {
    let out = ctx.run(&ctx.command(["diff", "--name-only", "--diff-filter=U", "-z"]))?;
    let paths: BTreeSet<_> = out
        .stdout
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect();
    Ok(paths.into_iter().collect())
}

pub(super) fn raw(ctx: &WriteContext<'_>, command: &GitCommand) -> Result<GitRun, YagguiError> {
    ctx.git.run_raw(command, Some(ctx.cancel), None)
}

pub(super) fn classify(ctx: &WriteContext<'_>, run: &GitRun) -> YagguiError {
    classify_git_failure(
        &run.stderr,
        "",
        Some(&ctx.workdir.display().to_string()),
        Some(ctx.repo_id),
    )
}

/// Runs a `git switch`; a refusal to overwrite local changes becomes `dirtyWorktree`.
fn switch(ctx: &WriteContext<'_>, args: &[&str]) -> Result<(), YagguiError> {
    let run = raw(
        ctx,
        &ctx.command(std::iter::once("switch").chain(args.iter().copied())),
    )?;
    if run.success {
        return Ok(());
    }
    match overwritten_paths(&run.stderr) {
        Some(paths) => Err(YagguiError::dirty_worktree(paths, false).with_detail(&run.stderr)),
        None => Err(classify(ctx, &run)),
    }
}

// --- Checkout ---------------------------------------------------------------------------

/// A resolved checkout: `git switch` arguments, the commit HEAD will be on, and the branch.
struct Resolved {
    args: Vec<String>,
    commit: String,
    branch: Option<String>,
    created: bool,
}

fn resolve_target(
    ctx: &WriteContext<'_>,
    target: &CheckoutTarget,
) -> Result<Resolved, YagguiError> {
    match target {
        CheckoutTarget::Branch { name } => {
            let id = existing_branch(ctx, name)?;
            Ok(Resolved {
                args: vec!["--no-guess".into(), name.clone()],
                commit: id.to_string(),
                branch: Some(name.clone()),
                created: false,
            })
        }
        CheckoutTarget::Remote { name } => {
            let full = format!("refs/remotes/{name}");
            let remote_id = match find_ref(ctx.repo, &full)? {
                Some(id) if !name.starts_with('-') => id,
                _ => return Err(YagguiError::revision_not_found(name)),
            };
            let local = local_name_for_remote(ctx.repo, name)
                .ok_or_else(|| YagguiError::revision_not_found(name))?;
            check_ref_format(
                ctx.git,
                ctx.workdir,
                ctx.repo_id,
                RefNameKind::Branch,
                &local,
            )?;
            if let Some(id) = find_ref(ctx.repo, &format!("refs/heads/{local}"))? {
                return Ok(Resolved {
                    args: vec!["--no-guess".into(), local.clone()],
                    commit: id.to_string(),
                    branch: Some(local),
                    created: false,
                });
            }
            Ok(Resolved {
                args: vec!["--create".into(), local.clone(), "--track".into(), full],
                commit: remote_id.to_string(),
                branch: Some(local),
                created: true,
            })
        }
        CheckoutTarget::Detached { rev } => {
            let id = resolve_commit(ctx.repo, rev)?.to_string();
            Ok(Resolved {
                args: vec!["--detach".into(), id.clone()],
                commit: id,
                branch: None,
                created: false,
            })
        }
    }
}

/// `origin/feat/x` → `feat/x`, using the longest configured remote name that prefixes it.
fn local_name_for_remote(repo: &gix::Repository, name: &str) -> Option<String> {
    let remotes = repo.remote_names();
    let remote = remotes
        .iter()
        .map(|r| r.to_string())
        .filter(|r| name.starts_with(&format!("{r}/")))
        .max_by_key(String::len);
    let rest = match remote {
        Some(remote) => &name[remote.len() + 1..],
        None => name.split_once('/')?.1,
    };
    (!rest.is_empty() && rest != "HEAD").then(|| rest.to_owned())
}

fn checkout(
    ctx: &WriteContext<'_>,
    target: &CheckoutTarget,
    mode: CheckoutMode,
) -> Result<CheckoutResult, YagguiError> {
    let resolved = resolve_target(ctx, target)?;
    let result = CheckoutResult {
        branch: resolved.branch.clone(),
        created: resolved.created,
    };
    let args: Vec<&str> = resolved.args.iter().map(String::as_str).collect();
    let status = worktree_status(ctx)?;
    if status.unmerged {
        return Err(YagguiError::unresolved_conflicts());
    }
    let unborn = ctx
        .repo
        .head()
        .map_err(|e| BackendError::gix("read HEAD", e))?
        .is_unborn();
    if status.tracked.is_empty() || unborn {
        // Untracked files only: a plain switch refuses by itself to overwrite one, unless
        // they are stashed out of the way first.
        let stash_untracked =
            mode == CheckoutMode::StashAndPop && !unborn && !status.untracked.is_empty() && {
                let changed = changed_between_head_and(ctx, &resolved.commit)?;
                status.untracked.iter().any(|p| changed.contains(p))
            };
        if stash_untracked {
            stash_checkout_pop(ctx, &args, target)?;
        } else {
            switch(ctx, &args)?;
        }
        return Ok(result);
    }
    match mode {
        CheckoutMode::Carry => {
            switch(ctx, &args)?;
            Ok(result)
        }
        CheckoutMode::Clean => {
            let changed = changed_between_head_and(ctx, &resolved.commit)?;
            let blocking: Vec<String> = status
                .tracked
                .iter()
                .chain(status.untracked.iter())
                .filter(|p| changed.contains(*p))
                .cloned()
                .collect();
            let can_carry = blocking.is_empty();
            Err(YagguiError::dirty_worktree(blocking, can_carry))
        }
        CheckoutMode::StashAndPop => {
            stash_checkout_pop(ctx, &args, target)?;
            Ok(result)
        }
    }
}

fn stash_checkout_pop(
    ctx: &WriteContext<'_>,
    args: &[&str],
    target: &CheckoutTarget,
) -> Result<(), YagguiError> {
    let label = match target {
        CheckoutTarget::Branch { name } | CheckoutTarget::Remote { name } => name.as_str(),
        CheckoutTarget::Detached { rev } => rev.as_str(),
    };
    let before = find_ref(ctx.repo, "refs/stash")?;
    ctx.run(&ctx.command([
        "stash".to_owned(),
        "push".to_owned(),
        "--include-untracked".to_owned(),
        format!("--message=yaggui: before checkout of {label}"),
    ]))?;
    let Some(stash) = find_ref(ctx.repo, "refs/stash")?.filter(|id| Some(*id) != before) else {
        // Nothing was stashed after all (changes undone meanwhile): a plain switch.
        return switch(ctx, args);
    };
    let entry = StashEntryInfo {
        sha: stash.to_string(),
        message: String::new(),
    };
    let top = StashId {
        index: 0,
        sha: entry.sha.clone(),
    };
    if let Err(err) = switch(ctx, args) {
        // Put the changes back where they were; the checkout error is the one to report.
        apply_stash(ctx, &top, &entry, true, false, true)?;
        return Err(err);
    }
    apply_stash(ctx, &top, &entry, true, true, true).map(drop)
}

// --- Branches ---------------------------------------------------------------------------

fn create_branch(
    ctx: &WriteContext<'_>,
    name: &str,
    from: &BranchStart,
    checkout: bool,
) -> Result<(), YagguiError> {
    let start = match from {
        BranchStart::Stash { stash } => return stash_branch(ctx, stash, name),
        BranchStart::Head => "HEAD".to_owned(),
        BranchStart::Commit { sha } => resolve_commit(ctx.repo, sha)?.to_string(),
        BranchStart::Ref { full_name } => {
            let known = ["refs/heads/", "refs/remotes/", "refs/tags/"]
                .iter()
                .any(|prefix| full_name.starts_with(prefix));
            if !known || find_ref(ctx.repo, full_name)?.is_none() {
                return Err(YagguiError::revision_not_found(full_name));
            }
            full_name.clone()
        }
    };
    check_new_name(ctx, RefNameKind::Branch, name)?;
    if checkout {
        switch(ctx, &["--create", name, &start])
    } else {
        ctx.run(&ctx.command(["branch", "--", name, &start]))
            .map(drop)
    }
}

fn delete_branch(
    ctx: &WriteContext<'_>,
    request: &DeleteBranchRequest,
) -> Result<DeleteBranchResult, YagguiError> {
    let name = request.name.as_str();
    let sha = existing_branch(ctx, name)?;
    if current_branch(ctx.repo)?.as_deref() == Some(name) {
        return Err(YagguiError::current_branch(name));
    }
    let upstream = if request.delete_remote {
        let (remote, merge) = upstream_of(ctx, name)?;
        remote.zip(merge)
    } else {
        None
    };
    let run = raw(
        ctx,
        &ctx.command([
            "branch",
            if request.force { "-D" } else { "-d" },
            "--",
            name,
        ]),
    )?;
    if !run.success {
        let lower = run.stderr.to_ascii_lowercase();
        return Err(if lower.contains("not fully merged") {
            YagguiError::branch_not_merged(name).with_detail(&run.stderr)
        } else if lower.contains("checked out at") || lower.contains("used by worktree") {
            // Checked out in another worktree.
            YagguiError::current_branch(name).with_detail(&run.stderr)
        } else {
            classify(ctx, &run)
        });
    }
    let local = DeletedRef {
        full_name: format!("refs/heads/{name}"),
        sha: sha.to_string(),
    };
    let remote = match upstream {
        // `.` is a local upstream: there is no remote branch to delete.
        Some((remote, merge)) if remote != "." && !remote.starts_with('-') => {
            let short = merge.strip_prefix("refs/heads/").unwrap_or(&merge);
            let tracking = format!("refs/remotes/{remote}/{short}");
            let before = find_ref(ctx.repo, &tracking)?;
            let run = raw(ctx, &ctx.command(["push", &remote, "--delete", &merge]))?;
            if run.success || run.stderr.contains("remote ref does not exist") {
                before.map(|id| DeletedRef {
                    full_name: tracking,
                    sha: id.to_string(),
                })
            } else {
                // The local branch is already gone: report its SHA (undo) with the failure.
                return Ok(DeleteBranchResult {
                    local,
                    remote: None,
                    remote_error: Some(classify(ctx, &run)),
                });
            }
        }
        _ => None,
    };
    Ok(DeleteBranchResult {
        local,
        remote,
        remote_error: None,
    })
}

// --- Stashes ----------------------------------------------------------------------------

fn stash_ref(index: u32) -> String {
    format!("stash@{{{index}}}")
}

/// The entry `stash` designates, `staleRefs` when the list changed since it was read.
fn verify_stash(ctx: &WriteContext<'_>, stash: &StashId) -> Result<StashEntryInfo, YagguiError> {
    let entries = read_stashes(ctx.repo)?;
    let entry = usize::try_from(stash.index)
        .ok()
        .and_then(|index| entries.into_iter().nth(index))
        .filter(|entry| entry.id.to_string().eq_ignore_ascii_case(stash.sha.trim()))
        .ok_or_else(YagguiError::stale_refs)?;
    Ok(StashEntryInfo {
        sha: entry.id.to_string(),
        message: entry.message,
    })
}

fn stash_push(
    ctx: &WriteContext<'_>,
    request: &StashPushRequest,
) -> Result<StashEntryInfo, YagguiError> {
    let mut args = vec!["stash".to_owned(), "push".to_owned(), "-q".to_owned()];
    if request.include_untracked {
        args.push("--include-untracked".into());
    }
    if request.keep_index {
        args.push("--keep-index".into());
    }
    if let Some(message) = request
        .message
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
    {
        args.push(format!("--message={message}"));
    }
    let before = find_ref(ctx.repo, "refs/stash")?;
    ctx.run(&ctx.command(args))?;
    let after = find_ref(ctx.repo, "refs/stash")?;
    if after.is_none() || after == before {
        return Err(YagguiError::nothing_to_stash());
    }
    let entry = read_stashes(ctx.repo)?
        .into_iter()
        .next()
        .ok_or_else(YagguiError::nothing_to_stash)?;
    Ok(StashEntryInfo {
        sha: entry.id.to_string(),
        message: entry.message,
    })
}

/// `git stash apply` / `pop` of a verified entry. Conflicts keep the stash and fail with
/// `stashConflict`; a refusal to overwrite local files, with `dirtyWorktree`.
fn apply_stash(
    ctx: &WriteContext<'_>,
    stash: &StashId,
    entry: &StashEntryInfo,
    pop: bool,
    checked_out: bool,
    index: bool,
) -> Result<StashEntryInfo, YagguiError> {
    let verb = if pop { "pop" } else { "apply" };
    let target = stash_ref(stash.index);
    let plain = || raw(ctx, &ctx.command(["stash", verb, &target]));
    let run = if index {
        // `--index` also restores the staged / unstaged split; it refuses without touching
        // anything when the staged part does not apply, and the plain apply runs instead.
        let indexed = raw(ctx, &ctx.command(["stash", verb, "--index", &target]))?;
        if !indexed.success && indexed.stderr.contains("Try without --index") {
            plain()?
        } else {
            indexed
        }
    } else {
        plain()?
    };
    if run.success {
        return Ok(entry.clone());
    }
    stash_failure(ctx, &run, &entry.sha, checked_out)
}

fn stash_failure<T>(
    ctx: &WriteContext<'_>,
    run: &GitRun,
    sha: &str,
    checked_out: bool,
) -> Result<T, YagguiError> {
    let output = format!("{}\n{}", run.stdout, run.stderr);
    if output.contains("CONFLICT") {
        let paths = unmerged_paths(ctx)?;
        return Err(
            YagguiError::stash_conflict(paths, sha.to_owned(), checked_out).with_detail(output),
        );
    }
    let lower = run.stderr.to_ascii_lowercase();
    if let Some(paths) = overwritten_paths(&run.stderr) {
        return Err(YagguiError::dirty_worktree(paths, false).with_detail(&run.stderr));
    }
    if lower.contains("already exists, no checkout")
        || lower.contains("could not restore untracked files")
    {
        // Tracked changes may already be applied; the stash is kept: same handling as a
        // conflict (the files listed are the untracked ones that could not be restored).
        let paths = run
            .stderr
            .lines()
            .filter_map(|line| line.strip_suffix(" already exists, no checkout"))
            .map(str::to_owned)
            .collect();
        return Err(
            YagguiError::stash_conflict(paths, sha.to_owned(), checked_out)
                .with_detail(&run.stderr),
        );
    }
    if lower.contains("needs merge") || lower.contains("in the middle of a merge") {
        return Err(YagguiError::unresolved_conflicts().with_detail(&run.stderr));
    }
    Err(classify(ctx, run))
}

fn stash_branch(ctx: &WriteContext<'_>, stash: &StashId, name: &str) -> Result<(), YagguiError> {
    let entry = verify_stash(ctx, stash)?;
    check_new_name(ctx, RefNameKind::Branch, name)?;
    let run = raw(
        ctx,
        &ctx.command(["stash", "branch", name, &stash_ref(stash.index)]),
    )?;
    if run.success {
        return Ok(());
    }
    // The branch exists and is checked out once Git reached the apply.
    let checked_out = current_branch(ctx.repo)?.as_deref() == Some(name);
    stash_failure(ctx, &run, &entry.sha, checked_out)
}

// --- Tags -------------------------------------------------------------------------------

fn create_tag(ctx: &WriteContext<'_>, request: &CreateTagRequest) -> Result<(), YagguiError> {
    check_new_name(ctx, RefNameKind::Tag, &request.name)?;
    let target = resolve_commit(ctx.repo, &request.target)?.to_string();
    let message = request
        .message
        .as_deref()
        .map(str::trim)
        .unwrap_or_default();
    if request.sign && message.is_empty() {
        return Err(YagguiError::invalid_argument(
            "A signed tag needs a message.",
            "Un tag signé a besoin d'un message.",
        ));
    }
    let mut command = ctx.command(["tag"]);
    if !message.is_empty() {
        command = command
            .arg(if request.sign { "-s" } else { "-a" })
            .arg("-F")
            .arg("-")
            .stdin(format!("{message}\n"));
    }
    ctx.run(&command.arg("--").arg(&request.name).arg(&target))
        .map(drop)
}
