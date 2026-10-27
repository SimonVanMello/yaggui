//! Payloads of the write commands (staging, discard, commit).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::git::errors::YagguiError;
use crate::git::read::diff::types::DiffOptions;

/// Paths a file-level command applies to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PathSelection {
    /// Every changed path of the list the command works on.
    All,
    /// Repository-relative, `/`-separated paths, as listed by `changed_files`.
    Paths { paths: Vec<String> },
}

/// Part of one hunk of a file diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HunkSelection {
    /// `DiffHunk::id` of the diff the selection was made on.
    pub id: String,
    /// Indexes into the hunk lines (`DiffHunk::kinds`) of the `+`/`-` lines to include;
    /// context lines are ignored. `None` takes the whole hunk.
    pub lines: Option<Vec<u32>>,
}

/// A selection of hunks (or lines) of one file diff, with what identifies that diff so a
/// stale selection is refused (`staleDiff`) instead of applied to other content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HunkChange {
    pub path: String,
    /// Source of a rename (staged diffs only), as in `FileDiff::old_path`.
    pub old_path: Option<String>,
    /// `FileDiff::old_id` / `new_id` of the diff the selection was made on.
    pub old_id: Option<String>,
    pub new_id: Option<String>,
    /// Options of that diff: context lines and whole-file mode decide the hunk ids.
    /// `ignore_whitespace` is refused (its hunks do not describe the real content).
    pub options: DiffOptions,
    pub hunks: Vec<HunkSelection>,
}

/// What a discard saved before touching the files, for the undo (M4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscardResult {
    /// Folder name of the backup under `<app config>/backups/`.
    pub backup_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    /// First line of the message; must not be empty.
    pub summary: String,
    /// Body, after a blank line; empty for none.
    pub description: String,
    /// Replace the HEAD commit (its message and content) instead of adding one.
    pub amend: bool,
    /// `--no-verify`: skip the `pre-commit` and `commit-msg` hooks. Off by default in the UI.
    pub skip_hooks: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    /// Full SHA of the new commit.
    pub sha: String,
}

/// A commit message split the way the commit box shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitMessage {
    pub summary: String,
    pub description: String,
}

/// `user.name` / `user.email` as Git resolves them for the repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentity {
    pub name: Option<String>,
    pub email: Option<String>,
}

/// Where `set_git_identity` writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConfigScope {
    /// The repository's `.git/config`.
    Repo,
    /// The user's `~/.gitconfig`.
    Global,
}

/// Kind of ref a name is checked for (`validate_ref_name`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RefNameKind {
    Branch,
    Tag,
}

/// What `checkout` moves HEAD to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CheckoutTarget {
    /// A local branch, short name (`feat/graph`).
    Branch { name: String },
    /// A remote-tracking branch, short name with its remote (`origin/feat/graph`): checks out
    /// the local branch of the same name, created to track it when missing (F-045).
    Remote { name: String },
    /// Any revision (SHA, tag…), checked out as a detached HEAD.
    Detached { rev: String },
}

/// How `checkout` treats local changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CheckoutMode {
    /// Refused with `dirtyWorktree` when tracked files have changes (staged or not); its
    /// payload tells whether `carry` would work.
    Clean,
    /// Plain `git switch`: changes come along when they do not touch the files that differ
    /// between HEAD and the target; refused with `dirtyWorktree` otherwise.
    Carry,
    /// Stash (untracked files included), check out, pop. A failed checkout pops the stash
    /// back; a conflicting pop keeps the stash and fails with `stashConflict`.
    StashAndPop,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutResult {
    /// Branch now checked out (short name); `None` for a detached HEAD.
    pub branch: Option<String>,
    /// The local branch was created by this checkout (remote target).
    pub created: bool,
    /// Remote target whose local branch was behind it: the local branch was fast-forwarded
    /// to it (short name of the remote branch, `origin/main`).
    pub fast_forwarded: Option<String>,
}

/// Where a new branch starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BranchStart {
    Head,
    /// A commit SHA (full or abbreviated).
    Commit {
        sha: String,
    },
    /// A full ref name: `refs/heads/…`, `refs/remotes/…` (tracked, as Git does by default)
    /// or `refs/tags/…`.
    #[serde(rename_all = "camelCase")]
    Ref {
        full_name: String,
    },
    /// A stash, by `git stash branch`: the branch starts at the stash's base commit, is
    /// always checked out, gets the stash applied, and the stash is dropped when it applies.
    Stash {
        stash: StashId,
    },
}

/// A stash entry as listed by `list_refs`. The SHA guards against a list that changed since
/// (`staleRefs`): a stale index never applies or drops another stash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashId {
    /// `StashRef::index` (0 = `stash@{0}`).
    pub index: u32,
    /// `StashRef::sha`.
    pub sha: String,
}

/// One file of a stash to bring back into the working tree (F-185).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashFileRequest {
    pub stash: StashId,
    /// Repository-relative path, as the stash preview lists it.
    pub path: String,
    /// The file comes from the untracked files of the stash (its third parent), not from
    /// its tracked changes.
    pub untracked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBranchRequest {
    /// Short name of the local branch.
    pub name: String,
    /// `-D`: delete even when not merged. Without it, `branchNotMerged` is returned.
    pub force: bool,
    /// Also delete the branch on its upstream remote (`git push <remote> --delete`).
    pub delete_remote: bool,
}

/// A deleted ref and where it pointed, for the undo (M4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeletedRef {
    pub full_name: String,
    pub sha: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBranchResult {
    pub local: DeletedRef,
    /// `refs/remotes/<remote>/<branch>` as it was before the remote deletion, when done.
    pub remote: Option<DeletedRef>,
    /// The remote deletion failed (network, rights…) after the local branch was deleted.
    pub remote_error: Option<YagguiError>,
}

/// Why the cleanup lists a branch (F-105).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CleanupBranch {
    /// Short name, `feat/x`.
    pub name: String,
    pub sha: String,
    /// Its tip is in the history of HEAD.
    pub merged: bool,
    /// Its upstream is configured but no longer exists (`[gone]`); short name in `upstream`.
    pub gone: bool,
    pub upstream: Option<String>,
    /// Commits only this branch reaches (not HEAD): what the deletion leaves to the reflog.
    /// 0 when merged.
    pub unmerged: u32,
}

/// Local branches the cleanup offers to delete, and the ones it leaves out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchCleanup {
    /// Branch the "merged" test uses (HEAD's), `None` when HEAD is detached or unborn.
    pub into: Option<String>,
    /// Merged or `[gone]` branches, sorted by name.
    pub branches: Vec<CleanupBranch>,
    /// Merged or `[gone]`, never offered: protected by the preferences.
    pub protected: Vec<String>,
    /// Merged or `[gone]`, never offered: checked out here or in another worktree.
    pub checked_out: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBranchesResult {
    /// Each deleted branch and the commit it pointed to.
    pub deleted: Vec<DeletedRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashPushRequest {
    /// Stash message; `None` or blank for Git's `WIP on <branch>: …`.
    pub message: Option<String>,
    /// `--include-untracked`.
    pub include_untracked: bool,
    /// `--keep-index`: staged changes also stay in the index and working tree.
    pub keep_index: bool,
}

/// A stash commit and its message: what `git stash store` needs to restore it (undo).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashEntryInfo {
    pub sha: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateTagRequest {
    pub name: String,
    /// Commit (or any revision) to tag.
    pub target: String,
    /// Non-blank: annotated tag with this message. `None` or blank: lightweight tag.
    pub message: Option<String>,
    /// `-s`: GPG-signed annotated tag (needs a message).
    pub sign: bool,
}

// --- History operations (M3-1) ------------------------------------------------------------

/// How `merge` integrates the other branch. Chosen for each merge (F-140), never read from
/// the `merge.ff` configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MergeMode {
    /// `--ff`: fast-forward when possible, merge commit otherwise.
    FastForward,
    /// `--ff-only`: refused with `notFastForward` when a merge commit would be needed.
    FastForwardOnly,
    /// `--no-ff`: always a merge commit.
    NoFastForward,
    /// `--squash`, then a regular (single-parent) commit of the result.
    Squash,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequest {
    /// What to merge into the current branch: a branch short name (`feat/x`, `origin/feat/x`),
    /// a full ref name or a commit SHA.
    pub source: String,
    pub mode: MergeMode,
    /// Message of the merge (or squash) commit. `None` or blank: Git's default
    /// (`Merge branch 'feat/x'`, the squashed commits list).
    pub message: Option<String>,
}

/// Moves a local branch forward to a revision that contains it, without creating a commit
/// (F-026). The branch need not be checked out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FastForwardRequest {
    /// Local branch short name to move.
    pub branch: String,
    /// Where it goes: a branch short name (`feat/x`, `origin/feat/x`), a full ref name or a
    /// commit SHA.
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FastForwardResult {
    /// The branch already contained `to`: nothing moved.
    pub up_to_date: bool,
    /// SHA the branch pointed to before, and after.
    pub previous: String,
    pub sha: String,
}

/// How two revisions `a` and `b` relate in the history: what a fast-forward between them can
/// do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RevisionRelation {
    /// Same commit.
    Same,
    /// `a` is an ancestor of `b`: `a` can be fast-forwarded to `b`.
    Behind,
    /// `b` is an ancestor of `a`: `b` can be fast-forwarded to `a`.
    Ahead,
    /// Neither contains the other (or unrelated histories): no fast-forward either way.
    Diverged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RebaseRequest {
    /// Local branch to rebase (short name). `None`: the current branch. Another branch is
    /// checked out first, as `git rebase <onto> <branch>` does, and stays checked out.
    pub branch: Option<String>,
    /// Where its commits are replayed: branch short name, full ref name or commit SHA.
    pub onto: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CherryPickRequest {
    /// Commits to apply on HEAD (full or abbreviated SHAs), in any order: they are applied
    /// in graph order, oldest first.
    pub commits: Vec<String>,
    /// Parent number (1-based) to diff merge commits against (`-m`). Required when a merge
    /// commit is picked (`mainlineRequired` otherwise).
    pub mainline: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RevertRequest {
    /// Commit to revert (full or abbreviated SHA).
    pub commit: String,
    /// For a merge commit, the parent (1-based) whose side is kept (`-m`): 1 = the branch
    /// the merge was made on. Required for a merge (`mainlineRequired`), refused otherwise.
    pub mainline: Option<u32>,
}

/// What a history operation did to HEAD.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum HistoryEffect {
    /// Nothing to do: already up to date, HEAD unchanged.
    UpToDate,
    /// The branch moved forward without a new commit.
    FastForward,
    /// New commits were created (merge, squash, rebased, picked or revert commits).
    Commits,
}

/// Result of an operation that ran to its end. An operation that stops on conflicts fails
/// with `conflicts` instead (it is then in progress: see `repo_state().operation`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryResult {
    pub effect: HistoryEffect,
    /// SHA of HEAD afterwards.
    pub head: String,
    /// SHA the moved branch (or detached HEAD) pointed to before, for the undo (M4). For a
    /// continue or skip, before the operation started (`ORIG_HEAD`) when known.
    pub previous_head: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ResetMode {
    /// Only the branch moves; index and working tree keep their content (all staged).
    Soft,
    /// The branch and the index move; the working tree keeps its content (unstaged).
    Mixed,
    /// Branch, index and working tree all take the target's content: local changes are lost
    /// (saved first in a backup, see `ResetResult::backup_id`).
    Hard,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResetRequest {
    /// Commit the current branch (or detached HEAD) is moved to.
    pub target: String,
    pub mode: ResetMode,
}

/// Why a file would lose content with a hard reset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LostChange {
    /// Tracked file with staged or unstaged changes (or conflicted): they are discarded.
    Modified,
    /// Added to the index since HEAD and absent from the target: the file is deleted.
    Added,
    /// Deleted locally (staged or not): the file comes back with the target's content.
    Deleted,
    /// Untracked file that the target tracks: it is overwritten.
    Untracked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LostFile {
    pub path: String,
    pub change: LostChange,
}

/// What a reset to a target would do, for the confirmation dialog (F-145).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResetPreview {
    /// Full SHA of the target.
    pub target: String,
    /// Branch that moves, `None` when HEAD is detached.
    pub branch: Option<String>,
    /// Commits of the branch that would no longer be on it (still in the reflog).
    pub commits_left_behind: u32,
    /// Commits the branch would gain (the target is ahead of it).
    pub commits_gained: u32,
    /// Files whose local content a `hard` reset loses (`soft` and `mixed` lose nothing).
    /// Sorted by path.
    pub hard_lost: Vec<LostFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResetResult {
    pub previous_head: String,
    pub head: String,
    /// Backup of the files a hard reset overwrote (`<app config>/backups/<id>`), like a
    /// discard; `None` when nothing was lost.
    pub backup_id: Option<String>,
}

// --- Operation in progress and conflicts (M3-1) -------------------------------------------

/// A commit as shown in a label: SHA and first line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitRef {
    pub sha: String,
    pub summary: String,
}

/// One side of a conflict, described by what the UI shows instead of "ours" / "theirs"
/// (F-163): a branch name when one is known, otherwise the commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SideLabel {
    /// Short branch name (`main`, `origin/feat/x`), or `None` (detached, unknown commit).
    pub branch: Option<String>,
    pub commit: Option<CommitRef>,
}

/// Who "ours" and "theirs" are in the current conflicts.
/// - merge: ours = the current branch, theirs = the merged branch;
/// - rebase: ours = the branch being rebased onto (with the commits already replayed),
///   theirs = the commit being replayed, from the rebased branch;
/// - cherry-pick: ours = the current branch, theirs = the picked commit;
/// - revert: ours = the current branch, theirs = the reverted commit (its inverse applies);
/// - stash apply/pop (no operation): ours = the current branch, theirs = no branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictLabels {
    pub ours: SideLabel,
    pub theirs: SideLabel,
}

/// Details of the operation in progress, for its banner (F-146) and the continue dialog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OperationDetail {
    pub operation: crate::git::read::state::RepoOperation,
    pub labels: ConflictLabels,
    /// Message Git prepared for the commit `continue_operation` creates (merge, squash,
    /// cherry-pick, revert, rebase step), without its `#` comment lines. Pre-fills the
    /// continue dialog. `None` when the operation creates no commit (bisect).
    pub message: Option<String>,
    /// Files still in conflict.
    pub unresolved: u32,
    /// `continue_operation` is possible now: no unresolved conflict and something to
    /// continue (always `false` for bisect).
    pub can_continue: bool,
    /// `skip_operation` is meaningful (rebase, cherry-pick, revert, mailbox, bisect).
    pub can_skip: bool,
}

/// A mark given to a commit during a bisect (F-263).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BisectMark {
    /// The bug is absent (`git bisect good`, or the repository's own "old" term).
    Good,
    /// The bug is present (`git bisect bad`, or the "new" term).
    Bad,
    /// The commit cannot be tested (`git bisect skip`).
    Skip,
}

/// A commit of the bisect, with what its banner and result show.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BisectCommit {
    pub sha: String,
    pub summary: String,
    pub author_name: String,
    /// Author date, seconds since the Unix epoch.
    pub author_time: f64,
}

/// How a bisect ended: Git has nothing left to test.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BisectResult {
    /// The first bad commit.
    Found { commit: BisectCommit },
    /// Only skipped commits are left between the good and bad ones: the first bad commit
    /// is one of `candidates` (the bad commit and those skipped commits), newest first.
    Inconclusive { candidates: Vec<BisectCommit> },
    /// The bad commit is an ancestor of a good one (marks taken in a terminal, where Git
    /// records them before refusing): nothing is left to test until the marks change.
    InconsistentMarks,
}

/// The bisect in progress, read from `refs/bisect/*`, `BISECT_START` and `BISECT_TERMS`
/// (the same files `git bisect` reads, so a bisect started in a terminal or interrupted by
/// closing the app is found as it was).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BisectState {
    /// The commit marked bad, `None` until one is.
    pub bad: Option<String>,
    /// Commits marked good.
    pub good: Vec<String>,
    /// Commits marked skipped.
    pub skipped: Vec<String>,
    /// The commit checked out for testing (HEAD); `None` when HEAD is unborn.
    pub current: Option<BisectCommit>,
    /// The current commit already has a mark while commits are left to test: checking out
    /// the next one failed (a file in the way) or HEAD was moved by hand. `bisect_next`
    /// checks out the commit to test.
    pub awaiting_checkout: bool,
    /// Commits that can still be the first bad one and are not skipped, the bad commit
    /// included; `None` until a good and a bad commit are known.
    pub remaining: Option<u32>,
    /// Steps left, estimated the way `git bisect` does (about log2 of the commits left).
    pub steps: Option<u32>,
    /// Set once Git has nothing left to test.
    pub result: Option<BisectResult>,
    /// Where `bisect reset` takes HEAD back: the branch checked out when the bisect started,
    /// or a commit SHA when HEAD was detached.
    pub original: Option<String>,
    /// Started with `--first-parent` (first-parent mode on, F-032): only the first parents of
    /// the bad commit are tested, and `remaining` / `steps` count them alone.
    pub first_parent: bool,
}

/// How a path is in conflict (index stages, as `git status` reports them).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictKind {
    /// Changed on both sides (`UU`).
    Content,
    /// Added on both sides with different content (`AA`).
    BothAdded,
    /// Deleted on our side, modified on theirs (`DU`).
    DeletedByUs,
    /// Modified on our side, deleted on theirs (`UD`).
    DeletedByThem,
    /// Only on our side, e.g. a rename against a deletion (`AU`).
    AddedByUs,
    /// Only on their side (`UA`).
    AddedByThem,
    /// Deleted on both sides, e.g. renamed differently (`DD`).
    BothDeleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    /// `None` once resolved (Git no longer records how it was in conflict).
    pub kind: Option<ConflictKind>,
    /// One of the versions is binary: no line-by-line merge, choose a side (F-165).
    pub binary: bool,
    /// Marked resolved (staged) since the operation stopped.
    pub resolved: bool,
}

/// Conflicted files of the working tree (F-160), resolved ones included while the
/// operation that stopped on them is in progress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictList {
    /// Sorted by path.
    pub files: Vec<ConflictFile>,
    pub unresolved: u32,
    pub labels: ConflictLabels,
}

/// How `resolve_conflicts` settles files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConflictResolution {
    /// Take our version (`checkout --ours`), or delete the file when our side deleted it.
    Ours,
    /// Take their version (`checkout --theirs`), or delete the file when their side did.
    Theirs,
    /// Keep the working tree file as it is (edited by hand), or its absence: `git add` /
    /// `git rm`.
    MarkResolved,
    /// Write `content` (the result of the 3-way editor, UTF-8) then mark resolved. One path
    /// only.
    Content { content: String },
}

/// One version of a conflicted file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSide {
    /// Blob id (index stage) or `None` for the working tree.
    pub id: Option<String>,
    /// Text, `None` when binary. Not UTF-8 text is decoded lossily.
    pub text: Option<String>,
    pub binary: bool,
    /// Bytes, saturated at `u32::MAX` (specta refuses `u64`).
    pub size: u32,
}

/// Everything the 3-way merge editor (M3-3) needs for one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictVersions {
    pub path: String,
    /// `None` when the file is not (or no longer) in conflict.
    pub kind: Option<ConflictKind>,
    /// Common ancestor version (stage 1); `None` when absent there (add/add…).
    pub base: Option<ConflictSide>,
    /// Stage 2; `None` when our side deleted it.
    pub ours: Option<ConflictSide>,
    /// Stage 3; `None` when their side deleted it.
    pub theirs: Option<ConflictSide>,
    /// Working tree file, with conflict markers for a content conflict; `None` when absent.
    pub merged: Option<ConflictSide>,
    pub labels: ConflictLabels,
}

/// Index stage of a conflicted file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictStage {
    Base,
    Ours,
    Theirs,
}

/// Outcome of the external merge tool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeToolResult {
    /// The file is resolved (the tool saved it and Git staged it); `false` when the tool was
    /// closed without resolving it.
    pub resolved: bool,
}

// --- Interactive rebase (M3-4) ---------------------------------------------------------

/// What happens to a commit in an interactive rebase (F-142).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RebaseAction {
    /// Keep the commit as it is.
    Pick,
    /// Keep its changes with a new message (`RebaseTodoEntry::message`, required).
    Reword,
    /// Meld into the previous kept commit, combining the messages: the group's message is
    /// the `message` of its last `squash` entry (required there).
    Squash,
    /// Meld into the previous kept commit, keeping that commit's message; with a `message`,
    /// Git's `fixup -C`: the group's message becomes that one (an `amend!` commit).
    Fixup,
    /// Remove the commit.
    Drop,
    /// Apply the commit then stop: the rebase stays in progress (amend, add commits…), then
    /// `continue_operation` / `skip_operation` / `abort_operation`.
    Edit,
}

/// One line of the todo list, oldest commit first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RebaseTodoEntry {
    /// Full SHA, as listed by `interactive_rebase_plan`.
    pub sha: String,
    pub action: RebaseAction,
    /// New message (summary, blank line, body) for `reword`, and for the last `squash` or
    /// `fixup -C` of a group: the message of the combined commit. Ignored for `pick`, `edit`
    /// and `drop`. Kept verbatim, lines starting with `#` included; no editor is ever opened.
    pub message: Option<String>,
}

/// A commit of the range an interactive rebase rewrites.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RebasePlanCommit {
    pub sha: String,
    pub summary: String,
    /// Full message, to pre-fill a reword or a squash.
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    /// Author time, seconds since the Unix epoch.
    pub author_time: f64,
    /// A merge commit: the interactive rebase is refused (`hasMerges`).
    pub merge: bool,
    /// Already on the upstream branch: rewriting it means a force push.
    pub pushed: bool,
}

/// The commits of `base..HEAD` an interactive rebase would rewrite (F-142).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveRebasePlan {
    /// The commit the rewritten ones are replayed on (excluded from the list).
    pub base: CommitRef,
    /// SHA of HEAD when the plan was read.
    pub head: String,
    /// Current branch (short name).
    pub branch: String,
    /// Upstream of the branch (`origin/main`), `None` when it has none.
    pub upstream: Option<String>,
    /// Oldest first, the order of the todo list. At most `REBASE_PLAN_MAX` commits.
    pub commits: Vec<RebasePlanCommit>,
    /// The range contains merge commits: `interactive_rebase` refuses it (yaggui does not
    /// rebuild merges, `--rebase-merges`).
    pub has_merges: bool,
    /// Number of `commits` already on the upstream.
    pub pushed: u32,
}

/// An interactive rebase plan with the `fixup!` commits already moved under their targets
/// (F-147), for review before running it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AutosquashPlan {
    pub plan: InteractiveRebasePlan,
    /// Every commit of `plan` once, oldest first, in the order `git rebase --autosquash`
    /// gives: each matched `fixup!` commit as a `fixup`, `squash!` as a `squash` (no message:
    /// the combination is the default) and `amend!` as a `fixup` whose `message` is the one
    /// the `amend!` commit carries (`fixup -C`), under their target; the others as `pick`.
    pub todo: Vec<RebaseTodoEntry>,
    /// SHAs of the `fixup!` / `squash!` / `amend!` commits whose target is not in the plan:
    /// left in place, picked.
    pub unmatched: Vec<String>,
    /// Number of entries of `todo` moved under a target (`fixup` and `squash`).
    pub fixups: u32,
}

/// Maximum number of commits of an interactive rebase plan.
pub const REBASE_PLAN_MAX: u32 = 200;

/// Where an interactive rebase stopped on an `edit` step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStop {
    /// The commit just applied (HEAD), to amend or build on.
    pub commit: CommitRef,
    /// 1-based step and number of steps, as in `RepoOperation::Rebase`.
    pub step: Option<u32>,
    pub total: Option<u32>,
}

/// Result of `interactive_rebase`. A stop on conflicts fails with `conflicts` instead, like
/// `rebase`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveRebaseResult {
    pub effect: HistoryEffect,
    /// SHA of HEAD afterwards (the edited commit when stopped).
    pub head: String,
    /// SHA of the branch before the rebase, for the undo (M4).
    pub previous_head: String,
    /// Stopped on an `edit` step: the rebase is in progress (`repo_state().operation`).
    pub stopped: Option<RebaseStop>,
}

// --- Network (M2-5) ----------------------------------------------------------------------

/// `true` when `branch` (short name on the remote) matches one of the protected branch
/// `patterns` (a preference, F-324). A trailing `/*` matches one or more levels.
pub fn is_protected_branch(branch: &str, patterns: &[String]) -> bool {
    patterns
        .iter()
        .any(|pattern| match pattern.strip_suffix("/*") {
            Some(prefix) => branch
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.len() > 1 && rest.starts_with('/')),
            None => branch == pattern,
        })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FetchTarget {
    Remote { name: String },
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PullStrategy {
    FfOnly,
    Merge,
    Rebase,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    /// The strategy used (the configured default when none was given).
    pub strategy: PullStrategy,
    /// HEAD did not move.
    pub up_to_date: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PushRequest {
    /// Local branch to push; `None` for the checked out one.
    pub branch: Option<String>,
    /// When the branch has no upstream: push to `remote` (default `origin`) and set it
    /// (`-u`). Without it, `noUpstream` is returned.
    pub set_upstream: bool,
    pub remote: Option<String>,
    /// `--force-with-lease`, refused on protected branches (`protectedBranch`).
    pub force_with_lease: bool,
    /// SHA the remote branch must still point to (the one the confirmation showed);
    /// `None`: its remote-tracking ref.
    pub expected_sha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub remote: String,
    /// Short name of the branch on the remote.
    pub remote_branch: String,
    pub upstream_set: bool,
    /// Nothing was sent: the remote branch already pointed there.
    pub up_to_date: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub sha: String,
    pub summary: String,
    pub author: String,
}

/// What a force push of a branch would overwrite, for its confirmation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ForcePushPreview {
    /// The local branch that would be pushed.
    pub branch: String,
    pub remote: String,
    pub remote_branch: String,
    /// Remote-tracking SHA (as of the last fetch); `None` if the branch is not on the remote.
    pub remote_sha: Option<String>,
    /// Commits on the remote branch that the push would drop (newest first, at most 100).
    pub overwritten: Vec<CommitSummary>,
    /// How many more commits than the listed ones would be dropped.
    pub hidden: u32,
    /// Force push is refused on this branch.
    pub protected: bool,
}

// --- Undo / redo (M4-1) -------------------------------------------------------------------

/// A journaled operation, with what its label needs. The frontend writes the text (i18n).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum JournalOp {
    /// A new commit.
    Commit {
        sha: String,
        summary: String,
    },
    /// HEAD commit replaced by `commit` with `amend`.
    Amend {
        sha: String,
        summary: String,
    },
    /// `branch`: the branch checked out, `None` for a detached HEAD on `sha`.
    Checkout {
        branch: Option<String>,
        sha: String,
    },
    CreateBranch {
        name: String,
    },
    /// `remote`: its remote branch was deleted too (then not undoable: `published`).
    DeleteBranch {
        name: String,
        remote: bool,
    },
    RenameBranch {
        from: String,
        to: String,
    },
    CreateTag {
        name: String,
    },
    DeleteTag {
        name: String,
    },
    AddRemote {
        name: String,
    },
    RenameRemote {
        from: String,
        to: String,
    },
    /// Fetch and push URLs changed (`git remote set-url`).
    SetRemoteUrls {
        name: String,
    },
    /// Its tracking branches and the upstreams on it come back with an undo.
    RemoveRemote {
        name: String,
    },
    Merge {
        source: String,
        mode: MergeMode,
    },
    /// `branch` moved forward to `to` (a branch name or SHA as asked), checked out or not.
    FastForward {
        branch: String,
        to: String,
    },
    Reset {
        mode: ResetMode,
        target: String,
    },
    /// Discard of whole files or of hunks / lines. `paths`: the files touched (at most
    /// `JOURNAL_PATHS_MAX`), `count`: how many in total.
    Discard {
        paths: Vec<String>,
        count: u32,
    },
    StashDrop {
        message: String,
    },
    /// `count`: commits picked.
    CherryPick {
        count: u32,
    },
    Revert {
        sha: String,
    },
    /// Push of a branch or tag, or deletion of a remote branch or tag (`delete`).
    Push {
        remote: Option<String>,
        name: Option<String>,
        delete: bool,
    },
    /// Push of every local tag to `remote`. Never undoable (`published`).
    PushTags {
        remote: String,
    },
    /// Fetch with prune (a plain fetch only moves remote-tracking branches: not journaled).
    Fetch {
        remote: Option<String>,
    },
    Pull,
    /// `git worktree add` (M4-5). `branch`: checked out there, `None` for a detached HEAD.
    CreateWorktree {
        path: String,
        branch: Option<String>,
    },
    RemoveWorktree {
        path: String,
        branch: Option<String>,
    },
    /// `git lfs track`: `.gitattributes` changed.
    LfsTrack {
        pattern: String,
    },
    /// `git lfs pull`: never undoable (`downloaded`).
    LfsPull,
    /// `git submodule update`; `count`: submodules asked for, 0 for all. Never undoable.
    UpdateSubmodules {
        count: u32,
    },
    /// Stash of selected files (F-182). `paths` / `count` as for `Discard`.
    StashPush {
        message: String,
        paths: Vec<String>,
        count: u32,
    },
    /// One file applied from a stash (F-185); the stash itself is untouched.
    StashApplyFile {
        message: String,
        path: String,
    },
    /// A rule appended to the repository's `.gitignore` (F-069).
    Gitignore {
        rule: String,
    },
    /// Local branches deleted by the cleanup (F-105). `names`: at most `JOURNAL_PATHS_MAX`,
    /// `count`: how many in total.
    DeleteBranches {
        names: Vec<String>,
        count: u32,
    },
}

/// Paths listed by `JournalOp::Discard`, at most.
pub const JOURNAL_PATHS_MAX: u32 = 20;

/// Why an operation cannot be undone (or redone) now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UndoBlock {
    /// Push, or deletion of a remote branch / tag: the remote has it, an undo here would not
    /// change it.
    Published,
    /// Fetch with prune: the deleted remote-tracking branches only come back with a fetch.
    Pruned,
    /// Pull: what it fetched cannot be put back locally.
    Pulled,
    /// The state before the operation could not be recorded (e.g. conflicts in the index).
    NotRecorded,
    /// LFS objects or submodule commits were downloaded and checked out (M4-5).
    Downloaded,
    /// A worktree was removed with its local changes: they are gone (M4-5).
    FilesDeleted,
    /// Refs moved since the operation (in a terminal, or by an operation that is not
    /// journaled): full names (`refs/heads/main`, `HEAD`).
    Diverged { refs: Vec<String> },
    /// Objects the step needs (commits the refs pointed to, index trees, saved file contents)
    /// are no longer in the repository, usually pruned by `git gc` (M7-1). `count`: how many.
    ObjectsMissing { count: u32 },
    /// An entry from a previous session that this version of yaggui cannot read (M7-1).
    Unreadable,
}

/// One operation of the session journal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    /// Unique within the repository, across sessions (the journal is kept in `yaggui.db`).
    pub id: u32,
    pub op: JournalOp,
    /// When the operation finished, Unix time in milliseconds (`f64`: specta refuses `u64`).
    pub at: f64,
    /// Undone, and not redone since.
    pub undone: bool,
    /// Set for operations that can never be undone (push, fetch with prune, pull). In
    /// `op_history`, also `objectsMissing` when what the entry needs was pruned since.
    pub blocked: Option<UndoBlock>,
    /// Recorded by a previous session of the repository, reloaded from `yaggui.db` (M7-1).
    pub restored: bool,
}

/// What `undo` or `redo` would do now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UndoStep {
    pub entry: JournalEntry,
    /// Why it would be refused: the entry's own `blocked`, `objectsMissing` when what it
    /// needs was pruned, or `diverged` when refs moved since. Local changes it would overwrite are only found when it runs
    /// (`undoWouldOverwrite`).
    pub blocked: Option<UndoBlock>,
}

/// State of the undo / redo buttons of a repository.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UndoState {
    /// Latest operation not undone (this session or a previous one); `None`: nothing to undo.
    pub undo: Option<UndoStep>,
    /// Latest undone operation; `None` when nothing was undone, or when an operation was
    /// journaled since.
    pub redo: Option<UndoStep>,
}

// --- Commit and stash V1 (M4-7a) ------------------------------------------------------------

/// How Git signs commits in this repository (`gpg.format`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SigningFormat {
    Openpgp,
    Ssh,
    X509,
}

/// What the commit panel shows before a commit: the `commit.template` message and whether
/// Git will sign.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitSettings {
    /// Message of the `commit.template` file, comment lines removed. `None`: no template, or
    /// unreadable (`template_error`).
    pub template: Option<CommitMessage>,
    /// The configured path, as Git resolved it.
    pub template_path: Option<String>,
    /// Why the configured template could not be read.
    pub template_error: Option<String>,
    /// `commit.gpgsign` is on: commits are signed with this format.
    pub sign: Option<SigningFormat>,
    /// `user.signingkey`, when set (a key id, or a path for SSH).
    pub signing_key: Option<String>,
}

/// Result of checking a commit signature (`%G?`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SignatureStatus {
    /// No signature.
    Unsigned,
    /// Good signature from a trusted key (`G`).
    Verified,
    /// Good signature, but the key is not known to be the author's (`U`), or it cannot be
    /// checked here (`E`: missing key, `N` with a signature: no `gpg.ssh.allowedSignersFile`).
    Unverified,
    /// Good signature made by a key or with a signature that has expired (`X`, `Y`).
    Expired,
    /// Signature made by a revoked key (`R`).
    Revoked,
    /// The signature does not match the commit (`B`).
    Bad,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SignatureCheck {
    pub status: SignatureStatus,
    /// `%GS`: who signed, as the key or allowed signers file names them.
    pub signer: Option<String>,
    /// `%GK`: key id or fingerprint.
    pub key: Option<String>,
    /// Why it could not be verified (first line of the verifier's error).
    pub reason: Option<String>,
}

/// Which rule "Add to .gitignore" writes for a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GitignoreRuleKind {
    /// This exact file (`/path/to/file`).
    File,
    /// Every file with its extension (`*.log`).
    Extension,
    /// Its folder (`/path/to/`).
    Folder,
}

/// What adding a rule to `.gitignore` would do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitignorePreview {
    /// The line to append.
    pub rule: String,
    /// The root `.gitignore` already has this line.
    pub exists: bool,
    /// Untracked files the rule would hide (at most `GITIGNORE_PREVIEW_MAX`).
    pub matches: Vec<String>,
    pub match_count: u32,
}

/// Untracked files listed by `GitignorePreview`, at most.
pub const GITIGNORE_PREVIEW_MAX: u32 = 50;

/// `git stash push -- <paths>` (F-182).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashPathsRequest {
    /// Files to stash, staged and unstaged changes alike.
    pub paths: Vec<String>,
    pub message: Option<String>,
    /// Also stash the selected untracked files (otherwise they are left alone).
    pub include_untracked: bool,
}
