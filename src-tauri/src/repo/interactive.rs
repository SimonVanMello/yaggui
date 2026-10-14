//! Interactive rebase (M3-4, F-142): the plan of `base..HEAD` and the rebase itself.
//!
//! yaggui writes the todo list (`git/ops/rebase_todo.rs`) to a file of its own temporary
//! folder; Git's sequence editor only copies it over the todo Git prepared. That editor is
//! a constant shell snippet using shell builtins only (no `cp`, nothing looked up in
//! `PATH`): the file path reaches it through `YAGGUI_REBASE_TODO`, never inside the command
//! string, so no user data is ever parsed by a shell. `GIT_EDITOR` stays `:`: messages come
//! with twin commits (see `rebase_todo`).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use gix::ObjectId;
use gix::bstr::ByteSlice;

use crate::events::{OpKind, OpNote};
use crate::git::errors::{BackendError, HistoryOp, YagguiError};
use crate::git::ops::rebase_todo::{self, TodoLine};
use crate::git::ops::types::{
    CommitRef, HistoryEffect, InteractiveRebasePlan, InteractiveRebaseResult, REBASE_PLAN_MAX,
    RebasePlanCommit, RebaseStop, RebaseTodoEntry,
};
use crate::git::read::state::{RepoOperation, count_exclusive, gix as gix_err, read_operation};
use crate::graph::resolve_commit;

use super::RepoManager;
use super::history::{ensure_idle, failure, head_id, rev_arg, run_history};
use super::ref_ops::worktree_status;
use super::write::WriteContext;

/// `GIT_SEQUENCE_EDITOR`: Git runs it as `sh -c '<this> "$@"' <todo path>`, so `f` gets the
/// path of Git's todo as `$1`. Builtins only (`read`, `printf`), the last line kept even
/// without a final newline; a missing `YAGGUI_REBASE_TODO` fails the redirection, and with
/// it the rebase, before anything is rewritten.
const SEQUENCE_EDITOR: &str = r#"f() { while IFS= read -r l || [ -n "$l" ]; do printf '%s\n' "$l"; done < "$YAGGUI_REBASE_TODO" > "$1"; }; f"#;

impl RepoManager {
    pub fn interactive_rebase_plan(
        &self,
        repo_id: u32,
        base: &str,
    ) -> Result<InteractiveRebasePlan, YagguiError> {
        let repo = self.session(repo_id)?.repo()?.to_thread_local();
        read_plan(&repo, base)
    }

    pub fn interactive_rebase(
        &self,
        repo_id: u32,
        base: String,
        todo: Vec<RebaseTodoEntry>,
    ) -> Result<InteractiveRebaseResult, YagguiError> {
        self.write_op(repo_id, OpKind::Rebase, true, move |ctx| {
            let result = interactive_rebase(ctx, &base, &todo)?;
            if result.stopped.is_some() {
                ctx.op.set_note(OpNote::Paused);
            }
            Ok(result)
        })
    }
}

/// Current branch and HEAD, refused when detached or unborn.
fn branch_and_head(repo: &gix::Repository) -> Result<(String, ObjectId), YagguiError> {
    let Some(name) = repo.head_name().map_err(gix_err("read HEAD"))? else {
        return Err(YagguiError::detached_head());
    };
    let head = repo
        .head_id()
        .map_err(|_| {
            YagguiError::invalid_argument(
                "There is no commit to rebase yet.",
                "Il n'y a pas encore de commit à rebaser.",
            )
        })?
        .detach();
    Ok((name.shorten().to_string(), head))
}

/// Commits of `base..head`, oldest first, and whether merges are among them.
fn range(
    repo: &gix::Repository,
    base: ObjectId,
    head: ObjectId,
) -> Result<(Vec<ObjectId>, bool), YagguiError> {
    if base == head {
        return Ok((Vec::new(), false));
    }
    if count_exclusive(repo, base, head)? != 0 {
        let short = &base.to_string()[..7];
        return Err(YagguiError::invalid_argument(
            format!("{short} is not an ancestor of the current branch."),
            format!("{short} n'est pas un ancêtre de la branche courante."),
        ));
    }
    let walk = repo
        .rev_walk([head])
        .with_hidden([base])
        .all()
        .map_err(gix_err("walk history"))?;
    let mut ids = Vec::new();
    let mut first_parent = HashMap::new();
    let mut merges = false;
    for info in walk {
        let info = info.map_err(gix_err("walk history"))?;
        merges |= info.parent_ids.len() > 1;
        if let Some(parent) = info.parent_ids.first() {
            first_parent.insert(info.id, *parent);
        }
        ids.push(info.id);
        if ids.len() > REBASE_PLAN_MAX as usize {
            return Err(YagguiError::invalid_argument(
                format!(
                    "More than {REBASE_PLAN_MAX} commits to rebase: choose a more recent base."
                ),
                format!(
                    "Plus de {REBASE_PLAN_MAX} commits à rebaser : choisis une base plus récente."
                ),
            ));
        }
    }
    if merges {
        // Refused anyway: only listed, newest first as walked.
        ids.reverse();
        return Ok((ids, true));
    }
    // Linear: follow the parents from HEAD down to the base.
    let mut chain = Vec::with_capacity(ids.len());
    let mut current = Some(head);
    while let Some(id) = current.filter(|id| *id != base) {
        chain.push(id);
        current = first_parent.get(&id).copied();
    }
    chain.reverse();
    Ok((chain, false))
}

/// Commits of the upstream of `branch` since `base`: those already pushed.
fn pushed_commits(
    repo: &gix::Repository,
    branch: &str,
    base: ObjectId,
) -> Result<(Option<String>, HashSet<ObjectId>), YagguiError> {
    let full = format!("refs/heads/{branch}");
    let Ok(full) = gix::refs::FullName::try_from(full) else {
        return Ok((None, HashSet::new()));
    };
    let tracking =
        match repo.branch_remote_tracking_ref_name(full.as_ref(), gix::remote::Direction::Fetch) {
            Some(Ok(name)) => name,
            _ => return Ok((None, HashSet::new())),
        };
    let name = tracking.shorten().to_string();
    let Some(mut reference) = repo
        .try_find_reference(tracking.as_ref())
        .map_err(gix_err("find upstream"))?
    else {
        return Ok((Some(name), HashSet::new()));
    };
    let upstream = reference
        .peel_to_id()
        .map_err(gix_err("peel upstream"))?
        .detach();
    let walk = repo
        .rev_walk([upstream])
        .with_hidden([base])
        .all()
        .map_err(gix_err("walk history"))?;
    let mut pushed = HashSet::new();
    for info in walk {
        pushed.insert(info.map_err(gix_err("walk history"))?.id);
    }
    Ok((Some(name), pushed))
}

fn read_plan(repo: &gix::Repository, base: &str) -> Result<InteractiveRebasePlan, YagguiError> {
    let (branch, head) = branch_and_head(repo)?;
    let base = resolve_commit(repo, rev_arg(base)?)?;
    let (ids, has_merges) = range(repo, base, head)?;
    let (upstream, pushed) = pushed_commits(repo, &branch, base)?;
    let mut commits = Vec::with_capacity(ids.len());
    for id in ids {
        let commit = repo.find_commit(id).map_err(gix_err("read a commit"))?;
        let decoded = commit.decode().map_err(gix_err("decode a commit"))?;
        let author = decoded.author().ok();
        commits.push(RebasePlanCommit {
            sha: id.to_string(),
            summary: decoded.message().summary().to_string(),
            message: decoded.message.to_str_lossy().trim_end().to_owned(),
            author_name: author
                .map(|a| a.name.to_str_lossy().trim().to_owned())
                .unwrap_or_default(),
            author_email: author
                .map(|a| a.email.to_str_lossy().trim().to_owned())
                .unwrap_or_default(),
            author_time: author
                .and_then(|a| a.time().ok())
                .map_or(0.0, |t| t.seconds as f64),
            merge: decoded.parents().count() > 1,
            pushed: pushed.contains(&id),
        });
    }
    let pushed = commits.iter().filter(|c| c.pushed).count();
    Ok(InteractiveRebasePlan {
        base: commit_ref(repo, base)?,
        head: head.to_string(),
        branch,
        upstream,
        commits,
        has_merges,
        pushed: u32::try_from(pushed).unwrap_or(u32::MAX),
    })
}

fn commit_ref(repo: &gix::Repository, id: ObjectId) -> Result<CommitRef, YagguiError> {
    let commit = repo.find_commit(id).map_err(gix_err("read a commit"))?;
    let summary = commit
        .message()
        .map(|m| m.summary().to_string())
        .unwrap_or_default();
    Ok(CommitRef {
        sha: id.to_string(),
        summary,
    })
}

fn interactive_rebase(
    ctx: &WriteContext<'_>,
    base: &str,
    todo: &[RebaseTodoEntry],
) -> Result<InteractiveRebaseResult, YagguiError> {
    ensure_idle(ctx)?;
    let (_, previous) = branch_and_head(ctx.repo)?;
    let status = worktree_status(ctx)?;
    if !status.tracked.is_empty() {
        return Err(YagguiError::local_changes(
            HistoryOp::Rebase,
            status.tracked.into_iter().collect(),
        ));
    }
    let base = resolve_commit(ctx.repo, rev_arg(base)?)?;
    let (ids, has_merges) = range(ctx.repo, base, previous)?;
    if has_merges {
        return Err(YagguiError::invalid_argument(
            "The commits to rebase include merges: yaggui does not rebuild them. Choose a base after the last merge.",
            "Les commits à rebaser contiennent des merges : yaggui ne les reconstruit pas. Choisis une base après le dernier merge.",
        ));
    }
    let lines = rebase_todo::plan(&ids, todo)?;
    let mut twins = HashMap::new();
    for (i, line) in lines.iter().enumerate() {
        if let Some(message) = &line.message {
            twins.insert(i, twin(ctx, line, message)?);
        }
    }
    let file = TodoFile::create(&rebase_todo::render(&lines, |i| twins.get(&i).copied()))?;
    // A SHA rather than a name: `git rebase` takes no `--` before its revisions.
    let command = ctx
        .command([
            "rebase".to_owned(),
            "--interactive".to_owned(),
            base.to_string(),
        ])
        .env("GIT_SEQUENCE_EDITOR", SEQUENCE_EDITOR)
        .env("YAGGUI_REBASE_TODO", file.editor_path());
    let run = run_history(ctx, &command)?;
    drop(file);
    if !run.success {
        return Err(failure(ctx, HistoryOp::Rebase, &run));
    }
    let head = head_id(ctx)?.ok_or_else(|| YagguiError::revision_not_found("HEAD"))?;
    let stopped = match read_operation(ctx.repo) {
        Some(RepoOperation::Rebase { step, total, .. }) => Some(RebaseStop {
            commit: commit_ref(ctx.repo, head)?,
            step,
            total,
        }),
        _ => None,
    };
    Ok(InteractiveRebaseResult {
        effect: if head == previous {
            HistoryEffect::UpToDate
        } else {
            HistoryEffect::Commits
        },
        head: head.to_string(),
        previous_head: previous.to_string(),
        stopped,
    })
}

/// A commit with the same tree, parents and author as `line.commit`, and `message`.
fn twin(ctx: &WriteContext<'_>, line: &TodoLine, message: &str) -> Result<ObjectId, YagguiError> {
    let commit = ctx
        .repo
        .find_commit(line.commit)
        .map_err(gix_err("read a commit"))?;
    let decoded = commit.decode().map_err(gix_err("decode a commit"))?;
    let mut command = ctx.command(["commit-tree".to_owned(), decoded.tree().to_string()]);
    for parent in decoded.parents() {
        command = command.arg("-p").arg(parent.to_string());
    }
    let mut command = command.arg("-F").arg("-").stdin(message);
    if let Ok(author) = decoded.author() {
        command = command
            .env("GIT_AUTHOR_NAME", author.name.to_str_lossy().trim())
            .env("GIT_AUTHOR_EMAIL", author.email.to_str_lossy().trim());
        if let Ok(time) = author.time() {
            command = command.env("GIT_AUTHOR_DATE", git_date(time));
        }
    }
    let out = ctx.run(&command)?;
    ObjectId::from_hex(out.stdout.trim().as_bytes()).map_err(|err| {
        BackendError::Invariant(format!("git commit-tree printed no commit id: {err}")).into()
    })
}

/// `@<seconds> ±hhmm`, Git's internal date format.
fn git_date(time: gix::date::Time) -> String {
    let sign = if time.offset < 0 { '-' } else { '+' };
    let offset = time.offset.unsigned_abs();
    format!(
        "@{} {sign}{:02}{:02}",
        time.seconds,
        offset / 3600,
        (offset % 3600) / 60
    )
}

/// The todo yaggui prepared, in a folder of its own under the system temporary folder,
/// removed once the rebase command returns.
struct TodoFile {
    dir: PathBuf,
    path: PathBuf,
}

impl TodoFile {
    fn create(content: &str) -> Result<Self, YagguiError> {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let dir = std::env::temp_dir().join(format!(
            "yaggui-rebase-{}-{nanos}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        #[cfg_attr(not(unix), allow(unused_mut))]
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        // `create`, not `create_all`: fails if the folder exists, so it is ours alone.
        builder
            .create(&dir)
            .map_err(|err| BackendError::io(format!("cannot create {}", dir.display()), err))?;
        let file = Self {
            path: dir.join("git-rebase-todo"),
            dir,
        };
        std::fs::write(&file.path, content).map_err(|err| {
            BackendError::io(format!("cannot write {}", file.path.display()), err)
        })?;
        Ok(file)
    }

    /// The path as the editor's shell reads it: `/` separators on Windows too (Git for
    /// Windows' `sh` accepts `C:/…`).
    fn editor_path(&self) -> String {
        let path = self.path.to_string_lossy();
        if cfg!(windows) {
            path.replace('\\', "/")
        } else {
            path.into_owned()
        }
    }
}

impl Drop for TodoFile {
    fn drop(&mut self) {
        if let Err(err) = std::fs::remove_dir_all(&self.dir) {
            tracing::warn!(error = %err, dir = %self.dir.display(), "cannot remove the rebase todo folder");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn todo_file_is_private_and_removed_on_drop() {
        let file = TodoFile::create("pick 1\n").unwrap();
        let dir = file.dir.clone();
        assert_eq!(std::fs::read_to_string(&file.path).unwrap(), "pick 1\n");
        assert!(!file.editor_path().contains('\\'));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        drop(file);
        assert!(!dir.exists());
    }

    #[test]
    fn formats_git_dates() {
        let time = |seconds, offset| gix::date::Time { seconds, offset };
        assert_eq!(git_date(time(1_700_000_000, 0)), "@1700000000 +0000");
        assert_eq!(git_date(time(1_700_000_000, 5400)), "@1700000000 +0130");
        assert_eq!(git_date(time(1_700_000_000, -18000)), "@1700000000 -0500");
    }
}
