//! Staging, discard and commit services of `RepoManager` (M2-1). Every write runs on the
//! repository's `OpQueue` and goes through `git/cli.rs`.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use gix::bstr::{BStr, ByteSlice};
use serde::Serialize;

use crate::events::OpKind;
use crate::git::cli::{CancelToken, GitCli, GitCommand, GitOutput, GitRun};
use crate::git::errors::{BackendError, ErrorCode, YagguiError, classify_git_failure};
use crate::git::ops::patch::{self, Direction, PatchInput, PatchSide};
use crate::git::ops::types::{
    CommitMessage, CommitRequest, CommitResult, ConfigScope, DiscardResult, GitIdentity,
    HunkChange, JournalOp, PathSelection,
};
use crate::git::read::diff::types::{DiffTarget, FileMode};
use crate::git::read::diff::{self, has_symlink_parent, validate_path};

use super::RepoManager;
use super::journal::{Mode, Plan};
use super::op_queue::OpContext;

/// Paths per `git clean` invocation (it takes no pathspec file).
const CLEAN_BATCH: usize = 200;
/// Per output stream of `git commit`: what a hook prints beyond it is cut in the middle.
const HOOK_OUTPUT_LIMIT: usize = 2 * 1024 * 1024;

/// What a write job can use.
pub(super) struct WriteContext<'a> {
    pub(super) git: &'a GitCli,
    pub(super) workdir: &'a Path,
    pub(super) repo: &'a gix::Repository,
    pub(super) repo_id: u32,
    pub(super) cancel: &'a CancelToken,
    pub(super) op: &'a OpContext<'a>,
}

impl WriteContext<'_> {
    pub(super) fn command<I, S>(&self, args: I) -> GitCommand
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        GitCommand::new(args)
            .cwd(self.workdir)
            .repo(self.repo_id)
            .index_lock(self.repo.index_path().with_extension("lock"))
    }

    pub(super) fn run(&self, command: &GitCommand) -> Result<GitOutput, YagguiError> {
        self.git.run_with(command, Some(self.cancel), None)
    }

    /// Like [`run_raw`](GitCli::run_raw), forwarding `--progress` output as `op-progress`.
    pub(super) fn run_progress(&self, command: &GitCommand) -> Result<GitRun, YagguiError> {
        let mut forward = |progress| self.op.progress(progress);
        self.git
            .run_raw(command, Some(self.cancel), Some(&mut forward))
    }

    /// Runs `args` with `--pathspec-from-file`: no argument list limit, no path parsed as
    /// an option, and `--literal-pathspecs` so `*` or `:` in a name are not patterns.
    pub(super) fn run_on_paths(&self, args: &[&str], paths: &[String]) -> Result<(), YagguiError> {
        if paths.is_empty() {
            return Ok(());
        }
        let mut command = self.command(["--literal-pathspecs"]);
        for arg in args {
            command = command.arg(arg);
        }
        let command = command
            .arg("--pathspec-from-file=-")
            .arg("--pathspec-file-nul")
            .stdin(nul_separated(paths));
        self.run(&command).map(drop)
    }

    pub(super) fn is_unborn(&self) -> Result<bool, YagguiError> {
        Ok(self
            .repo
            .head()
            .map_err(|e| BackendError::gix("read HEAD", e))?
            .is_unborn())
    }

    pub(super) fn index(
        &self,
    ) -> Result<Arc<gix::fs::FileSnapshot<gix::index::File>>, YagguiError> {
        self.repo
            .index_or_empty()
            .map_err(|e| BackendError::gix("read index", e).into())
    }
}

fn nul_separated(paths: &[String]) -> Vec<u8> {
    let mut out = Vec::new();
    for path in paths {
        out.extend_from_slice(path.as_bytes());
        out.push(0);
    }
    out
}

/// Repository-relative paths, refused when they could leave the working tree.
pub(super) fn checked_paths(
    workdir: &Path,
    paths: Vec<String>,
) -> Result<Vec<String>, YagguiError> {
    for path in &paths {
        validate_path(path)?;
        if has_symlink_parent(workdir, BStr::new(path.as_bytes())) {
            return Err(YagguiError::invalid_argument(
                format!("\"{path}\" is inside a symbolic link."),
                format!("« {path} » est dans un lien symbolique."),
            ));
        }
    }
    Ok(paths)
}

fn git_mode(mode: FileMode) -> &'static str {
    match mode {
        FileMode::Executable => "100755",
        FileMode::Symlink => "120000",
        FileMode::Submodule => "160000",
        FileMode::Regular => "100644",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HunkMode {
    Stage,
    Unstage,
    Discard,
}

impl RepoManager {
    /// Runs `job` on the repository's queue and waits for its result.
    pub(super) fn write_op<T: Send + 'static>(
        &self,
        repo_id: u32,
        kind: OpKind,
        cancellable: bool,
        job: impl FnOnce(&WriteContext<'_>) -> Result<T, YagguiError> + Send + 'static,
    ) -> Result<T, YagguiError> {
        let session = self.session(repo_id)?;
        let git = Arc::clone(&self.git);
        let job_session = Arc::clone(&session);
        session.queue().run(kind, cancellable, move |op| {
            let repo = job_session.repo()?.to_thread_local();
            job(&WriteContext {
                git: &git,
                workdir: &job_session.workdir,
                repo: &repo,
                repo_id,
                cancel: op.cancel,
                op,
            })
        })
    }

    pub(super) fn backup_dir(&self) -> Result<PathBuf, YagguiError> {
        self.backup_dir
            .clone()
            .ok_or_else(|| BackendError::Invariant("no backup folder configured".into()).into())
    }

    pub fn stage_paths(&self, repo_id: u32, paths: PathSelection) -> Result<(), YagguiError> {
        self.write_op(repo_id, OpKind::Stage, false, move |ctx| match paths {
            PathSelection::All => ctx.run(&ctx.command(["add", "-A"])).map(drop),
            PathSelection::Paths { paths } => {
                let paths = checked_paths(ctx.workdir, paths)?;
                ctx.run_on_paths(&["add", "-A"], &paths)
            }
        })
    }

    pub fn unstage_paths(&self, repo_id: u32, paths: PathSelection) -> Result<(), YagguiError> {
        self.write_op(repo_id, OpKind::Stage, false, move |ctx| match paths {
            // A pathspec, unlike a bare `git reset`, keeps an ongoing merge (MERGE_HEAD…).
            // Also fine on an unborn branch: the index is emptied.
            PathSelection::All => ctx.run(&ctx.command(["reset", "-q", "--", ":/"])).map(drop),
            PathSelection::Paths { paths } => {
                let mut paths = checked_paths(ctx.workdir, paths)?;
                paths.extend(rename_sources(ctx.repo, &paths)?);
                ctx.run_on_paths(&["reset", "-q"], &paths)
            }
        })
    }

    pub fn stage_hunks(&self, repo_id: u32, change: HunkChange) -> Result<(), YagguiError> {
        self.write_op(repo_id, OpKind::Stage, false, move |ctx| {
            apply_hunks(ctx, &change, HunkMode::Stage)
        })
    }

    pub fn unstage_hunks(&self, repo_id: u32, change: HunkChange) -> Result<(), YagguiError> {
        self.write_op(repo_id, OpKind::Stage, false, move |ctx| {
            apply_hunks(ctx, &change, HunkMode::Unstage)
        })
    }

    pub fn discard_hunks(
        &self,
        repo_id: u32,
        change: HunkChange,
    ) -> Result<DiscardResult, YagguiError> {
        let backups = self.backup_dir();
        self.journal_op(repo_id, OpKind::Discard, false, false, move |ctx| {
            let backups = backups?;
            let path = checked_paths(ctx.workdir, vec![change.path.clone()])?;
            let mut backup = Backup::create(&backups, ctx, "discardHunks")?;
            backup.save(ctx, &path[0], false)?;
            let (backup_id, saved) = backup.finish()?;
            apply_hunks(ctx, &change, HunkMode::Discard)?;
            Ok((DiscardResult { backup_id }, Some(Plan::discard(saved))))
        })
    }

    /// Writes a file edited in the diff view (see `diff::edit::save`). Queued like the Git
    /// writes, so it never lands in the middle of a checkout or a stash.
    pub fn save_worktree_file(
        &self,
        repo_id: u32,
        path: String,
        content: String,
        version: String,
    ) -> Result<String, YagguiError> {
        self.write_op(repo_id, OpKind::EditFile, false, move |ctx| {
            diff::edit::save(ctx.repo, &path, &content, &version)
        })
    }

    pub fn discard_paths(
        &self,
        repo_id: u32,
        paths: PathSelection,
        include_staged: bool,
    ) -> Result<DiscardResult, YagguiError> {
        let backups = self.backup_dir();
        self.journal_op(repo_id, OpKind::Discard, false, false, move |ctx| {
            let (result, saved) = discard_paths(ctx, &backups?, paths, include_staged)?;
            Ok((result, Some(Plan::discard(saved))))
        })
    }

    pub fn commit(
        &self,
        repo_id: u32,
        request: CommitRequest,
    ) -> Result<CommitResult, YagguiError> {
        let message = full_message(&request);
        let result = self.journal_op(repo_id, OpKind::Commit, true, false, move |ctx| {
            let result = commit(ctx, &request)?;
            let (sha, summary) = (result.sha.clone(), request.summary.trim().to_owned());
            let op = if request.amend {
                JournalOp::Amend { sha, summary }
            } else {
                JournalOp::Commit { sha, summary }
            };
            Ok((result, Some(Plan::new(op, Mode::Refs))))
        })?;
        // Recent messages (F-068): a failure here must not fail the commit that succeeded.
        if let Err(err) = self.store.add_recent_commit_message(repo_id, &message) {
            tracing::warn!(repo_id, error = %err, "recent commit message not saved");
        }
        Ok(result)
    }

    pub fn last_commit_message(&self, repo_id: u32) -> Result<Option<CommitMessage>, YagguiError> {
        let repo = self.session(repo_id)?.repo()?.to_thread_local();
        let head = repo.head().map_err(|e| BackendError::gix("read HEAD", e))?;
        if head.is_unborn() {
            return Ok(None);
        }
        let commit = repo
            .head_commit()
            .map_err(|e| BackendError::gix("read the HEAD commit", e))?;
        Ok(Some(split_message(
            &commit.message_raw_sloppy().to_str_lossy(),
        )))
    }

    /// Read with `git config`: it resolves includes and every scope exactly as `git commit`.
    pub fn git_identity(&self, repo_id: u32) -> Result<GitIdentity, YagguiError> {
        let session = self.session(repo_id)?;
        let get = |key: &str| -> Result<Option<String>, YagguiError> {
            let run = self.git.run_raw(
                &GitCommand::new(["config", "--get", key])
                    .cwd(&session.workdir)
                    .repo(repo_id),
                None,
                None,
            )?;
            let value = run.stdout.trim_end_matches(['\n', '\r']);
            Ok((run.success && !value.trim().is_empty()).then(|| value.to_owned()))
        };
        Ok(GitIdentity {
            name: get("user.name")?,
            email: get("user.email")?,
        })
    }

    pub fn set_git_identity(
        &self,
        repo_id: u32,
        name: &str,
        email: &str,
        scope: ConfigScope,
    ) -> Result<(), YagguiError> {
        let (name, email) = (name.trim().to_owned(), email.trim().to_owned());
        // Validated in the job, like every check of an operation: its failure is reported
        // by `op-finished` too.
        self.write_op(repo_id, OpKind::Maintenance, false, move |ctx| {
            let invalid = |v: &str| v.is_empty() || v.contains(['\n', '\r', '\0', '<', '>']);
            if invalid(&name) || invalid(&email) {
                return Err(YagguiError::invalid_argument(
                    "Name and email are required, on one line, without < or >.",
                    "Le nom et l'e-mail sont obligatoires, sur une ligne, sans < ni >.",
                ));
            }
            let scope = match scope {
                ConfigScope::Repo => "--local",
                ConfigScope::Global => "--global",
            };
            for (key, value) in [("user.name", &name), ("user.email", &email)] {
                ctx.run(&ctx.command(["config", scope, key]).arg(value))?;
            }
            Ok(())
        })
    }
}

/// Sources of the staged renames whose destination is in `paths`.
fn rename_sources(repo: &gix::Repository, paths: &[String]) -> Result<Vec<String>, YagguiError> {
    let wanted: BTreeSet<&str> = paths.iter().map(String::as_str).collect();
    Ok(diff::changed_paths(repo, &DiffTarget::Staged)?
        .into_iter()
        .filter(|c| wanted.contains(c.path.as_str()))
        .filter_map(|c| c.old_path)
        .filter(|old| !wanted.contains(old.as_str()))
        .collect())
}

fn apply_hunks(
    ctx: &WriteContext<'_>,
    change: &HunkChange,
    mode: HunkMode,
) -> Result<(), YagguiError> {
    if change.options.ignore_whitespace {
        return Err(YagguiError::invalid_argument(
            "Lines cannot be staged or discarded while whitespace is ignored.",
            "Impossible de stager ou d'annuler des lignes quand les espaces sont ignorés.",
        ));
    }
    if change.old_path.is_some() && mode != HunkMode::Unstage {
        return Err(YagguiError::invalid_argument(
            "Only a staged diff has a rename source.",
            "Seul un diff stagé a une source de renommage.",
        ));
    }
    checked_paths(ctx.workdir, vec![change.path.clone()])?;
    if change.hunks.is_empty() {
        return Ok(());
    }
    let target = match mode {
        HunkMode::Unstage => DiffTarget::Staged,
        HunkMode::Stage | HunkMode::Discard => DiffTarget::Unstaged,
    };
    let stale = || YagguiError::stale_diff(&change.path);
    let source = match diff::hunk_source(
        ctx.repo,
        &target,
        &change.path,
        change.old_path.as_deref(),
        &change.options,
    ) {
        // The file has no change here any more.
        Err(err) if err.code == ErrorCode::InvalidArgument && change.new_id.is_some() => {
            return Err(stale().with_detail(err.to_string()));
        }
        other => other?,
    };
    let id = |side: &Option<diff::SourceSide>| side.as_ref().map(|s| s.id.clone());
    if id(&source.old) != change.old_id || id(&source.new) != change.new_id {
        return Err(stale());
    }
    fn side(s: &diff::SourceSide) -> PatchSide<'_> {
        PatchSide {
            content: &s.content,
            mode: git_mode(s.mode),
        }
    }
    let mut input = PatchInput {
        path: &change.path,
        old: source.old.as_ref().map(side),
        new: source.new.as_ref().map(side),
        spans: &source.spans,
    };
    let direction = match mode {
        HunkMode::Stage => Direction::Forward,
        HunkMode::Unstage | HunkMode::Discard => Direction::Reverse,
    };
    // The index only changes under its lock, but the working tree file can be saved by an
    // editor between the read above and `git apply`: a discard carries the whole file as
    // context, so git refuses it unless the file is still exactly what was checked.
    let whole;
    let mut hunks = &change.hunks;
    if mode == HunkMode::Discard {
        whole = patch::whole_file(&input, &change.hunks).map_err(|_| stale())?;
        input.spans = &whole.0;
        hunks = &whole.1;
    }
    let Some(patch) = patch::build(&input, hunks, direction).map_err(|_| stale())? else {
        return Ok(());
    };
    let mut command = ctx.command(["apply"]);
    if mode != HunkMode::Discard {
        command = command.arg("--cached");
    }
    if direction == Direction::Reverse {
        command = command.arg("--reverse");
    }
    // Hunks may have no context (0 context lines, or a selection at the start of a file):
    // positions are exact, the ids were checked. A discard keeps git's checks that its
    // whole-file hunk matches from the first line to the last.
    command = command.arg("--whitespace=nowarn");
    if mode != HunkMode::Discard {
        command = command.arg("--unidiff-zero");
    }
    let command = command.arg("-").stdin(patch);
    match ctx.run(&command) {
        Err(err) if err.code == ErrorCode::StaleDiff => {
            let detail = err.detail.clone().unwrap_or_default();
            Err(stale().with_detail(detail))
        }
        other => other.map(drop),
    }
}

fn discard_paths(
    ctx: &WriteContext<'_>,
    backups: &Path,
    paths: PathSelection,
    include_staged: bool,
) -> Result<(DiscardResult, Vec<SavedPath>), YagguiError> {
    let mut selected: BTreeSet<String> = BTreeSet::new();
    match paths {
        PathSelection::All => {
            let mut targets = vec![DiffTarget::Unstaged];
            if include_staged {
                targets.push(DiffTarget::Staged);
            }
            for target in &targets {
                for change in diff::changed_paths(ctx.repo, target)? {
                    selected.extend(change.old_path);
                    selected.insert(change.path);
                }
            }
        }
        PathSelection::Paths { paths } => {
            let paths = checked_paths(ctx.workdir, paths)?;
            if include_staged {
                selected.extend(rename_sources(ctx.repo, &paths)?);
            }
            selected.extend(paths);
        }
    }
    let selected: Vec<String> = selected.into_iter().collect();
    let selected = checked_paths(ctx.workdir, selected)?;
    // Only files are backed up: a folder would be restored or cleaned as a whole.
    if let Some(dir) = selected
        .iter()
        .find(|path| std::fs::symlink_metadata(ctx.workdir.join(path)).is_ok_and(|m| m.is_dir()))
    {
        return Err(YagguiError::invalid_argument(
            format!("\"{dir}\" is a folder: discard its files instead."),
            format!("« {dir} » est un dossier : annule plutôt ses fichiers."),
        ));
    }

    let index = ctx.index()?;
    let in_index = |path: &str| {
        index.entry_by_path(BStr::new(path.as_bytes())).is_some()
            || index
                .entry_range(BStr::new(path.as_bytes()))
                .is_some_and(|r| !r.is_empty())
    };
    let unborn = ctx.is_unborn()?;
    let head_tree = if include_staged && !unborn {
        Some(
            ctx.repo
                .head_commit()
                .and_then(|c| c.tree())
                .map_err(|e| BackendError::gix("read HEAD tree", e))?,
        )
    } else {
        None
    };
    let in_head = |path: &str| -> Result<bool, YagguiError> {
        let Some(tree) = &head_tree else {
            return Ok(false);
        };
        Ok(tree
            .lookup_entry_by_path(path)
            .map_err(|e| BackendError::gix("read HEAD tree", e))?
            .is_some())
    };

    let mut backup = Backup::create(backups, ctx, "discardPaths")?;
    for path in &selected {
        backup.save(ctx, path, include_staged)?;
    }
    let (backup_id, saved) = backup.finish()?;

    let mut restore = Vec::new();
    let mut unstage = Vec::new();
    let mut clean = Vec::new();
    for path in selected {
        let indexed = in_index(&path);
        if include_staged && in_head(&path)? {
            restore.push(path);
        } else if include_staged && indexed {
            // Added since HEAD: dropped from the index, then deleted like an untracked file.
            if unborn {
                unstage.push(path.clone());
                clean.push(path);
            } else {
                restore.push(path);
            }
        } else if indexed {
            restore.push(path);
        } else {
            clean.push(path);
        }
    }
    drop(index);
    if include_staged && !unborn {
        ctx.run_on_paths(
            &["restore", "--source=HEAD", "--staged", "--worktree"],
            &restore,
        )?;
    } else {
        ctx.run_on_paths(&["restore", "--worktree"], &restore)?;
    }
    ctx.run_on_paths(
        &["rm", "-q", "-f", "--cached", "--ignore-unmatch"],
        &unstage,
    )?;
    for batch in clean.chunks(CLEAN_BATCH) {
        let mut command = ctx.command(["--literal-pathspecs", "clean", "-f", "-q", "--"]);
        for path in batch {
            command = command.arg(path);
        }
        ctx.run(&command)?;
    }
    Ok((DiscardResult { backup_id }, saved))
}

/// The message `git commit` receives: summary, blank line, description.
fn full_message(request: &CommitRequest) -> String {
    let mut message = request.summary.trim().to_owned();
    let description = request.description.trim_end();
    if !description.trim().is_empty() {
        message.push_str("\n\n");
        message.push_str(description.trim_start_matches(['\n', '\r']));
    }
    message.push('\n');
    message
}

pub(super) fn commit(
    ctx: &WriteContext<'_>,
    request: &CommitRequest,
) -> Result<CommitResult, YagguiError> {
    if request.summary.trim().is_empty() {
        return Err(YagguiError::invalid_argument(
            "The commit summary is empty.",
            "Le résumé du commit est vide.",
        ));
    }
    let message = full_message(request);

    if request.amend && ctx.is_unborn()? {
        return Err(YagguiError::invalid_argument(
            "There is no commit to amend yet.",
            "Il n'y a pas encore de commit à modifier.",
        ));
    }
    let mut command = ctx.command(["commit", "-F", "-"]);
    if request.amend {
        command = command.arg("--amend");
    }
    if request.skip_hooks {
        command = command.arg("--no-verify");
    }
    let command = command.stdin(message).capture_limit(HOOK_OUTPUT_LIMIT);
    let run = ctx.git.run_raw(&command, Some(ctx.cancel), None)?;
    if !run.success {
        let workdir = ctx.workdir.display().to_string();
        let err = classify_git_failure(&run.stderr, &run.stdout, Some(&workdir), Some(ctx.repo_id));
        // A failing hook makes Git exit with 1 without a message of its own: only the
        // hook's output, which no catalog pattern describes. Git's own failures (lock,
        // signing, bad object) exit with 128.
        if run.exit_code == Some(1)
            && matches!(err.code, ErrorCode::GitFailed | ErrorCode::StaleDiff)
        {
            let hooks = commit_hooks(ctx, request.skip_hooks);
            if !hooks.is_empty() {
                let name = (hooks.len() == 1).then_some(hooks[0]);
                return Err(YagguiError::hook_failed(
                    name,
                    run.exit_code,
                    run.stdout,
                    run.stderr,
                    run.truncated,
                ));
            }
        }
        return Err(err);
    }
    let sha = ctx
        .repo
        .head_id()
        .map_err(|e| BackendError::gix("read HEAD", e))?
        .to_string();
    Ok(CommitResult { sha })
}

/// Executable hooks `git commit` may have run.
fn commit_hooks(ctx: &WriteContext<'_>, skip_hooks: bool) -> Vec<&'static str> {
    let Ok(out) = ctx
        .git
        .run(&ctx.command(["rev-parse", "--git-path", "hooks"]))
    else {
        return Vec::new();
    };
    let dir = ctx.workdir.join(out.stdout.trim_end_matches(['\n', '\r']));
    // `prepare-commit-msg` runs even with `--no-verify`.
    let names: &[&'static str] = if skip_hooks {
        &["prepare-commit-msg"]
    } else {
        &["pre-commit", "prepare-commit-msg", "commit-msg"]
    };
    names
        .iter()
        .copied()
        .filter(|name| is_executable(&dir.join(name)))
        .collect()
}

pub(super) fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    meta.is_file()
}

/// Summary = first line; description = the rest, without the blank lines around it.
pub(super) fn split_message(message: &str) -> CommitMessage {
    let (summary, rest) = message.split_once('\n').unwrap_or((message, ""));
    CommitMessage {
        summary: summary.trim_end().to_owned(),
        description: rest.trim_start_matches(['\n', '\r']).trim_end().to_owned(),
    }
}

// ---- Discard backups -------------------------------------------------------------------

static NEXT_BACKUP: AtomicU32 = AtomicU32::new(0);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    repo_path: String,
    /// Unix time, milliseconds.
    created_at: u64,
    operation: &'static str,
    files: Vec<BackupEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupEntry {
    path: String,
    /// Working tree content (`None`: no file there).
    worktree: Option<StoredFile>,
    /// Index content, when the discard also reset the index.
    index: Option<StoredBlob>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredFile {
    /// File name in the backup folder.
    file: String,
    /// The content is a symlink target.
    symlink: bool,
    executable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredBlob {
    file: String,
    id: String,
    mode: String,
}

/// A backup folder being filled. Written completely before anything is discarded.
pub(super) struct Backup {
    id: String,
    dir: PathBuf,
    manifest: Manifest,
    saved: Vec<SavedPath>,
}

/// What a backup holds for one path, for the undo journal.
pub(super) struct SavedPath {
    pub(super) path: String,
    pub(super) worktree: SavedWorktree,
    pub(super) index: IndexSide,
}

pub(super) enum SavedWorktree {
    /// Not a file (a folder, a submodule): left alone.
    Unmanaged,
    Absent,
    /// Copy in the backup folder; a symlink is saved as a file holding its target.
    File {
        file: PathBuf,
        mode: u32,
    },
}

/// An index entry as the journal restores it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(super) enum IndexSide {
    /// Not touched by the operation (or a submodule): left alone.
    Unmanaged,
    Absent,
    Blob {
        #[serde(with = "super::journal::oid")]
        id: gix::ObjectId,
        mode: u32,
    },
    /// Conflict stages (base, ours, theirs) left by a merge of the file.
    Unmerged {
        stages: [Option<StageEntry>; 3],
    },
}

/// One conflict stage of an index entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(super) struct StageEntry {
    #[serde(with = "super::journal::oid")]
    pub(super) id: gix::ObjectId,
    pub(super) mode: u32,
}

pub(super) const MODE_FILE: u32 = 0o100_644;
pub(super) const MODE_EXECUTABLE: u32 = 0o100_755;
pub(super) const MODE_SYMLINK: u32 = 0o120_000;

fn io_error(context: String) -> impl FnOnce(std::io::Error) -> YagguiError {
    move |err| BackendError::io(context, err).into()
}

impl Backup {
    pub(super) fn create(
        root: &Path,
        ctx: &WriteContext<'_>,
        operation: &'static str,
    ) -> Result<Self, YagguiError> {
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
        let id = format!(
            "{created_at}-{}-{}",
            std::process::id(),
            NEXT_BACKUP.fetch_add(1, Ordering::Relaxed)
        );
        let dir = root.join(&id);
        std::fs::create_dir_all(root)
            .map_err(io_error(format!("cannot create {}", root.display())))?;
        std::fs::create_dir(&dir).map_err(io_error(format!("cannot create {}", dir.display())))?;
        Ok(Self {
            id,
            dir,
            manifest: Manifest {
                version: 1,
                repo_path: ctx.workdir.display().to_string(),
                created_at,
                operation,
                files: Vec::new(),
            },
            saved: Vec::new(),
        })
    }

    /// The backup folder, for files an operation keeps next to the backup (a patch).
    pub(super) fn dir(&self) -> &Path {
        &self.dir
    }

    fn next_file(&self, kind: &str) -> String {
        format!("{kind}-{}", self.manifest.files.len())
    }

    /// Saves the working tree file at `path` and, with `with_index`, its index entry.
    pub(super) fn save(
        &mut self,
        ctx: &WriteContext<'_>,
        path: &str,
        with_index: bool,
    ) -> Result<(), YagguiError> {
        let full = ctx.workdir.join(path);
        let mut saved_worktree = SavedWorktree::Absent;
        let worktree = match std::fs::symlink_metadata(&full) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let target = std::fs::read_link(&full)
                    .map_err(io_error(format!("cannot read {}", full.display())))?;
                let file = self.next_file("worktree");
                write_file(&self.dir.join(&file), target.to_string_lossy().as_bytes())?;
                saved_worktree = SavedWorktree::File {
                    file: self.dir.join(&file),
                    mode: MODE_SYMLINK,
                };
                Some(StoredFile {
                    file,
                    symlink: true,
                    executable: false,
                })
            }
            Ok(meta) if meta.is_file() => {
                let file = self.next_file("worktree");
                std::fs::copy(&full, self.dir.join(&file))
                    .map_err(io_error(format!("cannot back up {}", full.display())))?;
                let executable = is_executable(&full);
                saved_worktree = SavedWorktree::File {
                    file: self.dir.join(&file),
                    mode: if executable {
                        MODE_EXECUTABLE
                    } else {
                        MODE_FILE
                    },
                };
                Some(StoredFile {
                    file,
                    symlink: false,
                    executable,
                })
            }
            Ok(_) => {
                saved_worktree = SavedWorktree::Unmanaged;
                None
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => {
                return Err(
                    BackendError::io(format!("cannot back up {}", full.display()), err).into(),
                );
            }
        };
        let mut saved_index = IndexSide::Unmanaged;
        let index = if with_index {
            let index = ctx.index()?;
            match index.entry_by_path(BStr::new(path.as_bytes())) {
                Some(entry) if entry.mode.is_submodule() => None,
                Some(entry) => {
                    saved_index = IndexSide::Blob {
                        id: entry.id,
                        mode: entry.mode.bits(),
                    };
                    let object = ctx
                        .repo
                        .find_object(entry.id)
                        .map_err(|e| BackendError::gix("read a staged file", e))?;
                    let file = self.next_file("index");
                    write_file(&self.dir.join(&file), &object.data)?;
                    Some(StoredBlob {
                        file,
                        id: entry.id.to_string(),
                        mode: format!("{:o}", entry.mode.bits()),
                    })
                }
                None => {
                    saved_index = IndexSide::Absent;
                    None
                }
            }
        } else {
            None
        };
        self.manifest.files.push(BackupEntry {
            path: path.to_owned(),
            worktree,
            index,
        });
        self.saved.push(SavedPath {
            path: path.to_owned(),
            worktree: saved_worktree,
            index: saved_index,
        });
        Ok(())
    }

    /// Writes the manifest; returns the backup id and what was saved (undo journal).
    pub(super) fn finish(self) -> Result<(String, Vec<SavedPath>), YagguiError> {
        let json = serde_json::to_vec_pretty(&self.manifest).map_err(BackendError::from)?;
        write_file(&self.dir.join("manifest.json"), &json)?;
        Ok((self.id, self.saved))
    }
}

fn write_file(path: &Path, data: &[u8]) -> Result<(), YagguiError> {
    std::fs::write(path, data).map_err(io_error(format!("cannot write {}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_messages() {
        let m = split_message("Fix it\n\nBody line 1\nline 2\n\n");
        assert_eq!(m.summary, "Fix it");
        assert_eq!(m.description, "Body line 1\nline 2");
        let m = split_message("Only summary\n");
        assert_eq!(m.description, "");
    }
}
