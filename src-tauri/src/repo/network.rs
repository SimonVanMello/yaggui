//! Fetch, pull and push services of `RepoManager` (M2-5). Network commands run on the
//! repository's `OpQueue` with `--progress` (forwarded as `op-progress`) and can be
//! cancelled. No credential is ever handled here: Git's credential helpers and `ssh-agent`
//! do it, and `GIT_TERMINAL_PROMPT=0` turns a missing credential into `authFailed`.

use crate::events::OpKind;
use crate::git::cli::{GitCommand, GitRun};
use crate::git::errors::{YagguiError, classify_git_failure};
use crate::git::ops::remotes::TagPushResult;
use crate::git::ops::types::{
    CommitSummary, DeletedRef, FetchTarget, ForcePushPreview, JournalOp, PullResult, PullStrategy,
    PushRequest, PushResult, UndoBlock, is_protected_branch,
};
use crate::git::read::state::{RepoOperation, read_operation};

use super::RepoManager;
use super::journal::Plan;
use super::ref_ops::{
    current_branch, existing_branch, find_ref, overwritten_paths, unmerged_paths, upstream_of,
};
use super::remotes::push_tags;
use super::write::WriteContext;

/// Commits listed in a force push confirmation.
const PREVIEW_LIMIT: usize = 100;

/// Journal entry of a push: never undoable locally.
fn published(remote: Option<String>, name: Option<String>, delete: bool) -> Plan {
    Plan::blocked(
        JournalOp::Push {
            remote,
            name,
            delete,
        },
        UndoBlock::Published,
    )
}

impl RepoManager {
    /// Names of the configured remotes, `origin` first.
    pub fn remotes(&self, repo_id: u32) -> Result<Vec<String>, YagguiError> {
        let session = self.session(repo_id)?;
        let output = self.git.run(
            &GitCommand::new(["remote"])
                .cwd(&session.workdir)
                .repo(repo_id),
        )?;
        Ok(sort_remotes(&output.stdout))
    }

    /// Strategy a pull uses when none is given: the one chosen in the preferences, else
    /// `branch.<name>.rebase`, `pull.rebase`, then `pull.ff`; `ffOnly` when none is set (what
    /// Git ≥ 2.33 does on diverged branches).
    pub fn pull_default_strategy(&self, repo_id: u32) -> Result<PullStrategy, YagguiError> {
        if let Some(preferred) = self.store.preferences()?.pull_strategy {
            return Ok(preferred);
        }
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        let branch = current_branch(&repo)?;
        let get = |key: &str| self.config_get(&session.workdir, repo_id, key);
        default_strategy(&get, branch.as_deref())
    }

    pub fn fetch(&self, repo_id: u32, target: FetchTarget, prune: bool) -> Result<(), YagguiError> {
        self.journal_op(repo_id, OpKind::Fetch, true, false, move |ctx| {
            let mut args = vec!["fetch".to_owned(), "--progress".to_owned()];
            if prune {
                args.push("--prune".into());
            }
            let remote = match target {
                FetchTarget::All => {
                    args.push("--all".into());
                    None
                }
                FetchTarget::Remote { name } => {
                    let remote = checked_remote(ctx, &name)?;
                    args.push(remote.clone());
                    Some(remote)
                }
            };
            run_network(ctx, &ctx.command(args))?;
            // Without prune it only moves remote-tracking branches: nothing to undo.
            let plan = prune.then(|| Plan::blocked(JournalOp::Fetch { remote }, UndoBlock::Pruned));
            Ok(((), plan))
        })
    }

    pub fn pull(
        &self,
        repo_id: u32,
        strategy: Option<PullStrategy>,
    ) -> Result<PullResult, YagguiError> {
        // The preference stands in for "no strategy given"; without it, the Git config decides.
        let strategy = match strategy {
            Some(strategy) => Some(strategy),
            None => self.store.preferences()?.pull_strategy,
        };
        self.journal_op(repo_id, OpKind::Pull, true, false, move |ctx| {
            let result = pull(ctx, strategy)?;
            let plan =
                (!result.up_to_date).then(|| Plan::blocked(JournalOp::Pull, UndoBlock::Pulled));
            Ok((result, plan))
        })
    }

    pub fn push(&self, repo_id: u32, request: PushRequest) -> Result<PushResult, YagguiError> {
        let protected = self.store.preferences()?.protected_branches;
        self.journal_op(repo_id, OpKind::Push, true, false, move |ctx| {
            let result = push(ctx, &request, &protected)?;
            let plan = (!result.up_to_date).then(|| {
                published(
                    Some(result.remote.clone()),
                    Some(result.remote_branch.clone()),
                    false,
                )
            });
            Ok((result, plan))
        })
    }

    /// Pushes one tag; `tagRejected` when the remote has another tag of that name.
    pub fn push_tag(
        &self,
        repo_id: u32,
        remote: &str,
        name: &str,
    ) -> Result<TagPushResult, YagguiError> {
        let (remote, name) = (remote.to_owned(), name.to_owned());
        self.journal_op(repo_id, OpKind::Push, true, false, move |ctx| {
            let remote = checked_remote(ctx, &remote)?;
            let full = format!("refs/tags/{name}");
            if name.starts_with('-') || find_ref(ctx.repo, &full)?.is_none() {
                return Err(YagguiError::revision_not_found(&name));
            }
            let result = push_tags(ctx, &remote, &format!("{full}:{full}"))?;
            let plan =
                (!result.pushed.is_empty()).then(|| published(Some(remote), Some(name), false));
            Ok((result, plan))
        })
    }

    pub fn delete_remote_tag(
        &self,
        repo_id: u32,
        remote: &str,
        name: &str,
    ) -> Result<(), YagguiError> {
        let (remote, name) = (remote.to_owned(), name.to_owned());
        self.journal_op(repo_id, OpKind::Push, true, false, move |ctx| {
            let remote = checked_remote(ctx, &remote)?;
            if name.is_empty() || name.starts_with('-') {
                return Err(YagguiError::revision_not_found(&name));
            }
            let full = format!("refs/tags/{name}");
            let run = ctx.run_progress(&ctx.command([
                "push",
                "--progress",
                "--porcelain",
                &remote,
                "--delete",
                &full,
            ]))?;
            // Already gone on the remote: the wanted state, nothing published.
            if run.success {
                Ok(((), Some(published(Some(remote), Some(name), true))))
            } else if run_text(&run).contains("remote ref does not exist") {
                Ok(((), None))
            } else {
                Err(classify(ctx, &run))
            }
        })
    }

    /// Deletes `branch` on `remote`, and its remote-tracking ref (returned for the undo).
    pub fn delete_remote_branch(
        &self,
        repo_id: u32,
        remote: &str,
        branch: &str,
    ) -> Result<Option<DeletedRef>, YagguiError> {
        let (remote, branch) = (remote.to_owned(), branch.to_owned());
        self.journal_op(repo_id, OpKind::Push, true, false, move |ctx| {
            let remote = checked_remote(ctx, &remote)?;
            if branch.is_empty() || branch.starts_with('-') {
                return Err(YagguiError::revision_not_found(&branch));
            }
            let tracking = format!("refs/remotes/{remote}/{branch}");
            let before = find_ref(ctx.repo, &tracking)?;
            let full = format!("refs/heads/{branch}");
            let run = ctx.git.run_raw(
                &ctx.command(["push", "--porcelain", &remote, "--delete", &full]),
                Some(ctx.cancel),
                None,
            )?;
            // Already gone on the remote: only the stale tracking ref is left, prune it.
            if !run.success && run_text(&run).contains("remote ref does not exist") {
                ctx.run(&ctx.command(["update-ref", "-d", &tracking]))?;
            } else if !run.success {
                return Err(classify(ctx, &run));
            }
            let deleted = before.map(|id| DeletedRef {
                full_name: tracking,
                sha: id.to_string(),
            });
            Ok((deleted, Some(published(Some(remote), Some(branch), true))))
        })
    }

    /// What `push` with `forceWithLease` would overwrite on the branch's upstream (or on
    /// `remote`/branch when it has none). Read-only, not queued.
    pub fn force_push_preview(
        &self,
        repo_id: u32,
        branch: Option<String>,
    ) -> Result<ForcePushPreview, YagguiError> {
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        let branch = match branch {
            Some(branch) => branch,
            None => current_branch(&repo)?.ok_or_else(YagguiError::detached_head)?,
        };
        if branch.starts_with('-') || find_ref(&repo, &format!("refs/heads/{branch}"))?.is_none() {
            return Err(YagguiError::revision_not_found(&branch));
        }
        let get = |key: &str| self.config_get(&session.workdir, repo_id, key);
        let (remote, remote_branch) = match (
            get(&format!("branch.{branch}.remote"))?,
            get(&format!("branch.{branch}.merge"))?,
        ) {
            (Some(remote), Some(merge)) if remote != "." => (
                remote,
                merge
                    .strip_prefix("refs/heads/")
                    .unwrap_or(&merge)
                    .to_owned(),
            ),
            _ => return Err(YagguiError::no_upstream(&branch)),
        };
        let tracking = format!("refs/remotes/{remote}/{remote_branch}");
        let remote_sha = find_ref(&repo, &tracking)?;
        let mut overwritten = Vec::new();
        let mut hidden = 0;
        if remote_sha.is_some() {
            let range = format!("refs/heads/{branch}..{tracking}");
            let output = self.git.run(
                &GitCommand::new([
                    "log".to_owned(),
                    format!("--max-count={}", PREVIEW_LIMIT + 1),
                    "--format=%H%x1f%an%x1f%s".to_owned(),
                    range.clone(),
                    "--".to_owned(),
                ])
                .cwd(&session.workdir)
                .repo(repo_id),
            )?;
            for line in output.stdout.lines() {
                let mut fields = line.splitn(3, '\u{1f}');
                if let (Some(sha), Some(author), Some(summary)) =
                    (fields.next(), fields.next(), fields.next())
                {
                    overwritten.push(CommitSummary {
                        sha: sha.to_owned(),
                        author: author.to_owned(),
                        summary: summary.to_owned(),
                    });
                }
            }
            if overwritten.len() > PREVIEW_LIMIT {
                overwritten.truncate(PREVIEW_LIMIT);
                let count = self.git.run(
                    &GitCommand::new(["rev-list", "--count", range.as_str(), "--"])
                        .cwd(&session.workdir)
                        .repo(repo_id),
                )?;
                let total: usize = count.stdout.trim().parse().unwrap_or(PREVIEW_LIMIT + 1);
                hidden = u32::try_from(total.saturating_sub(PREVIEW_LIMIT)).unwrap_or(u32::MAX);
            }
        }
        Ok(ForcePushPreview {
            protected: is_protected_branch(
                &remote_branch,
                &self.store.preferences()?.protected_branches,
            ),
            branch,
            remote,
            remote_branch,
            remote_sha: remote_sha.map(|id| id.to_string()),
            overwritten,
            hidden,
        })
    }

    /// `git config --get <key>`, `None` when unset.
    fn config_get(
        &self,
        workdir: &std::path::Path,
        repo_id: u32,
        key: &str,
    ) -> Result<Option<String>, YagguiError> {
        let run = self.git.run_raw(
            &GitCommand::new(["config", "--get", key])
                .cwd(workdir)
                .repo(repo_id),
            None,
            None,
        )?;
        let value = run.stdout.trim().to_owned();
        Ok((run.success && !value.is_empty()).then_some(value))
    }
}

fn sort_remotes(stdout: &str) -> Vec<String> {
    let mut remotes: Vec<String> = stdout
        .lines()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .map(str::to_owned)
        .collect();
    remotes.sort_by_key(|r| r != "origin");
    remotes
}

fn default_strategy(
    get: &dyn Fn(&str) -> Result<Option<String>, YagguiError>,
    branch: Option<&str>,
) -> Result<PullStrategy, YagguiError> {
    let rebase = match branch {
        Some(branch) => get(&format!("branch.{branch}.rebase"))?,
        None => None,
    };
    let rebase = match rebase {
        Some(value) => Some(value),
        None => get("pull.rebase")?,
    };
    let rebase_set = rebase.is_some();
    if let Some(value) = rebase {
        let value = value.to_ascii_lowercase();
        if ["true", "yes", "on", "1", "merges", "m", "interactive", "i"].contains(&value.as_str()) {
            return Ok(PullStrategy::Rebase);
        }
    }
    Ok(match get("pull.ff")?.map(|v| v.to_ascii_lowercase()) {
        Some(ff) if ff == "only" => PullStrategy::FfOnly,
        Some(_) => PullStrategy::Merge,
        // An explicit `pull.rebase=false` means merge, as in Git.
        None if rebase_set => PullStrategy::Merge,
        None => PullStrategy::FfOnly,
    })
}

/// A configured remote name, refused when it is not one (`remoteNotFound`).
pub(super) fn checked_remote(ctx: &WriteContext<'_>, name: &str) -> Result<String, YagguiError> {
    let output = ctx.run(&ctx.command(["remote"]))?;
    if name.starts_with('-') || !output.stdout.lines().any(|r| r.trim() == name) {
        return Err(YagguiError::remote_not_found().with_detail(name));
    }
    Ok(name.to_owned())
}

fn run_text(run: &GitRun) -> String {
    format!("{}\n{}", run.stderr, run.stdout)
}

/// With `--porcelain`, `git push` reports refused refs on stdout: both are classified.
pub(super) fn classify(ctx: &WriteContext<'_>, run: &GitRun) -> YagguiError {
    classify_git_failure(
        &run_text(run),
        "",
        Some(&ctx.workdir.display().to_string()),
        Some(ctx.repo_id),
    )
}

pub(super) fn run_network(
    ctx: &WriteContext<'_>,
    command: &GitCommand,
) -> Result<GitRun, YagguiError> {
    let run = ctx.run_progress(command)?;
    if run.success {
        Ok(run)
    } else {
        Err(classify(ctx, &run))
    }
}

fn pull(ctx: &WriteContext<'_>, strategy: Option<PullStrategy>) -> Result<PullResult, YagguiError> {
    let branch = current_branch(ctx.repo)?.ok_or_else(YagguiError::detached_head)?;
    if let (None, _) | (_, None) = upstream_of(ctx, &branch)? {
        return Err(YagguiError::no_upstream(&branch));
    }
    let strategy = match strategy {
        Some(strategy) => strategy,
        None => {
            let get = |key: &str| -> Result<Option<String>, YagguiError> {
                let run = ctx.git.run_raw(
                    &ctx.command(["config", "--get", key]),
                    Some(ctx.cancel),
                    None,
                )?;
                let value = run.stdout.trim().to_owned();
                Ok((run.success && !value.is_empty()).then_some(value))
            };
            default_strategy(&get, Some(&branch))?
        }
    };
    let before = existing_branch(ctx, &branch)?;
    let flags: &[&str] = match strategy {
        // `--no-rebase` / `--ff` override `pull.rebase` / `pull.ff` from the configuration.
        PullStrategy::FfOnly => &["--no-rebase", "--ff-only"],
        PullStrategy::Merge => &["--no-rebase", "--ff"],
        PullStrategy::Rebase => &["--rebase"],
    };
    let mut command = ctx.command(["pull", "--progress"]);
    for flag in flags {
        command = command.arg(flag);
    }
    let run = ctx.run_progress(&command)?;
    if !run.success {
        let text = run_text(&run);
        return Err(match read_operation(ctx.repo) {
            // Same error and payload as a merge or rebase stopped on conflicts (M3-1): the
            // front shows the same banner and conflict view whatever started the operation.
            Some(operation @ (RepoOperation::Rebase { .. } | RepoOperation::Merge { .. })) => {
                YagguiError::pull_conflicts(operation, unmerged_paths(ctx)?)
            }
            _ => match overwritten_paths(&run.stderr) {
                Some(paths) => YagguiError::dirty_worktree(paths, false),
                None if text.contains("cannot pull with rebase") => {
                    YagguiError::dirty_worktree(Vec::new(), false)
                }
                None => return Err(classify(ctx, &run)),
            },
        }
        .with_detail(text));
    }
    Ok(PullResult {
        strategy,
        up_to_date: existing_branch(ctx, &branch)? == before,
    })
}

fn push(
    ctx: &WriteContext<'_>,
    request: &PushRequest,
    protected: &[String],
) -> Result<PushResult, YagguiError> {
    let branch = match &request.branch {
        Some(branch) => branch.clone(),
        None => current_branch(ctx.repo)?.ok_or_else(YagguiError::detached_head)?,
    };
    existing_branch(ctx, &branch)?;
    let (remote, merge, set_upstream) = match upstream_of(ctx, &branch)? {
        (Some(remote), Some(merge)) if remote != "." => (remote, merge, false),
        _ if request.set_upstream => {
            let remote = match &request.remote {
                Some(remote) => remote.clone(),
                None => default_remote(ctx)?,
            };
            (remote, format!("refs/heads/{branch}"), true)
        }
        _ => return Err(YagguiError::no_upstream(&branch)),
    };
    let remote = checked_remote(ctx, &remote)?;
    let remote_branch = merge
        .strip_prefix("refs/heads/")
        .unwrap_or(&merge)
        .to_owned();

    let mut args = vec![
        "push".to_owned(),
        "--progress".to_owned(),
        "--porcelain".to_owned(),
    ];
    if set_upstream {
        args.push("--set-upstream".into());
    }
    if request.force_with_lease {
        if is_protected_branch(&remote_branch, protected) {
            return Err(YagguiError::protected_branch(&remote_branch));
        }
        let expected = match &request.expected_sha {
            Some(sha) => sha.trim().to_owned(),
            None => find_ref(ctx.repo, &format!("refs/remotes/{remote}/{remote_branch}"))?
                .map(|id| id.to_string())
                // Empty: the branch must not exist on the remote yet.
                .unwrap_or_default(),
        };
        if !expected.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(YagguiError::revision_not_found(&expected));
        }
        args.push(format!("--force-with-lease={merge}:{expected}"));
    }
    args.push(remote.clone());
    args.push(format!("refs/heads/{branch}:{merge}"));
    let run = run_network(ctx, &ctx.command(args))?;
    let up_to_date = run
        .stdout
        .lines()
        .filter(|line| line.contains(&merge))
        .all(|line| line.starts_with('='));
    Ok(PushResult {
        remote,
        remote_branch,
        upstream_set: set_upstream,
        up_to_date,
    })
}

/// `origin` if it exists, else the only remote.
fn default_remote(ctx: &WriteContext<'_>) -> Result<String, YagguiError> {
    let output = ctx.run(&ctx.command(["remote"]))?;
    sort_remotes(&output.stdout)
        .into_iter()
        .next()
        .ok_or_else(YagguiError::remote_not_found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn strategy(config: &[(&str, &str)]) -> PullStrategy {
        let map: HashMap<String, String> = config
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        let get = |key: &str| Ok(map.get(key).cloned());
        default_strategy(&get, Some("main")).unwrap()
    }

    #[test]
    fn reads_the_default_pull_strategy() {
        assert_eq!(strategy(&[]), PullStrategy::FfOnly);
        assert_eq!(strategy(&[("pull.rebase", "true")]), PullStrategy::Rebase);
        assert_eq!(strategy(&[("pull.rebase", "merges")]), PullStrategy::Rebase);
        assert_eq!(strategy(&[("pull.rebase", "false")]), PullStrategy::Merge);
        assert_eq!(strategy(&[("pull.ff", "only")]), PullStrategy::FfOnly);
        assert_eq!(strategy(&[("pull.ff", "false")]), PullStrategy::Merge);
        assert_eq!(
            strategy(&[("pull.rebase", "true"), ("branch.main.rebase", "false")]),
            PullStrategy::Merge
        );
    }

    #[test]
    fn matches_protected_branches() {
        use crate::git::ops::types::is_protected_branch;
        let defaults: Vec<String> = crate::store::DEFAULT_PROTECTED_BRANCHES
            .iter()
            .map(|b| (*b).to_owned())
            .collect();
        let p = |branch: &str| is_protected_branch(branch, &defaults);
        assert!(p("main") && p("master") && p("develop") && p("release/1.0") && p("release/a/b"));
        assert!(!p("mainline") && !p("release") && !p("release/") && !p("feat/main"));
    }

    #[test]
    fn protected_branches_follow_the_preference() {
        use crate::git::ops::types::is_protected_branch;
        let custom = vec!["hotfix/*".to_owned(), "prod".to_owned()];
        assert!(is_protected_branch("hotfix/1", &custom) && is_protected_branch("prod", &custom));
        // Nothing is protected once the list is emptied, `main` included.
        assert!(!is_protected_branch("main", &custom));
        assert!(!is_protected_branch("main", &[]));
    }
}
