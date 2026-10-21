//! Typed errors sent to the frontend, and the catalog mapping known Git failures to them.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::git::ops::types::UndoBlock;
use crate::git::read::state::RepoOperation;
use crate::git::redact::redact_urls;

/// Stable machine-readable error code; the frontend switches on it, never on messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    /// The command exists in the contract but has no backend implementation yet.
    NotImplemented,
    /// The `git` binary could not be found or executed.
    GitNotFound,
    /// The path does not exist.
    RepoNotFound,
    /// The path exists but is not inside a Git repository.
    NotARepository,
    /// Git refuses the repository because of `safe.directory` (owned by another user).
    UnsafeRepository,
    /// `.git/index.lock` exists: another Git process is running, or one crashed.
    IndexLocked,
    /// A path exceeds Windows' 260-character limit and `core.longpaths` is off.
    PathTooLong,
    /// The repository id does not match an open repository session.
    RepoNotOpen,
    /// An unknown operation id was given.
    OpNotFound,
    /// The operation was cancelled by the user.
    Cancelled,
    /// A frontend-provided argument was rejected by validation.
    InvalidArgument,
    /// Reading or writing the local SQLite store failed.
    Storage,
    /// A Git command failed with an error not (yet) in the catalog.
    GitFailed,
    /// Unexpected internal failure (bug, I/O error…).
    Internal,
    /// The repository is open but its files are not watched: no automatic refresh.
    WatchUnavailable,
    /// No terminal could be started (the configured one, or none of the defaults).
    TerminalNotFound,
    /// The external editor could not be started.
    EditorNotFound,
    /// The system file manager could not open the repository folder.
    FileManagerFailed,
    /// The integrated terminal could not start a shell (no PTY, shell missing).
    ShellFailed,
    /// The integrated terminal session does not exist any more (shell exited, closed).
    TerminalClosed,
    /// An avatar could not be downloaded (offline, unexpected answer); nothing is cached.
    AvatarUnavailable,
    /// The update manifest could not be read (offline, unexpected answer).
    UpdateCheckFailed,
    /// The new version could not be downloaded, verified or installed.
    UpdateInstallFailed,
    /// The configured Git path does not exist or is not Git.
    GitBinaryInvalid,
    /// A SHA, branch or other revision does not exist in the repository.
    RevisionNotFound,
    /// Nothing staged to commit (and not an amend).
    NothingToCommit,
    /// `user.name` / `user.email` are not configured: Git refuses to commit.
    IdentityUnknown,
    /// A `pre-commit` / `commit-msg` hook rejected the commit; output in `payload`.
    HookFailed,
    /// The file changed since its diff was shown: the hunk selection no longer applies.
    StaleDiff,
    /// The file changed on disk since the editor loaded it: saving would overwrite that.
    FileChanged,
    /// Unmerged paths prevent the operation (resolve the conflicts first).
    UnresolvedConflicts,
    /// The operation needs a branch and HEAD is detached.
    DetachedHead,
    /// A branch or tag name refused by `git check-ref-format`.
    InvalidRefName,
    /// A branch or tag of that name already exists.
    RefExists,
    /// Local changes prevent the checkout; files and options in `payload`.
    DirtyWorktree,
    /// `git branch -d` refuses: the branch is not merged (action: force).
    BranchNotMerged,
    /// The checked out branch cannot be deleted.
    CurrentBranch,
    /// Applying a stash left conflicts; the stash is kept (`payload`).
    StashConflict,
    /// No local change to stash.
    NothingToStash,
    /// The refs (stash list…) changed since they were listed: refresh and retry.
    StaleRefs,
    /// A merge, rebase, cherry-pick or revert (or the merge or rebase of a pull) stopped on
    /// conflicts and is now in progress (`payload`): resolve them, then continue, skip or
    /// abort.
    Conflicts,
    /// A merge commit is cherry-picked or reverted without choosing its parent (`mainline`).
    MainlineRequired,
    /// The commit being applied brings no change any more (already applied): skip it.
    EmptyCommit,
    /// Continue, skip or abort while no operation is in progress.
    NoOperation,
    /// A merge, rebase, cherry-pick, revert or bisect is already in progress.
    OperationInProgress,
    /// No external merge tool is configured (`merge.tool`).
    MergeToolMissing,
    /// The external merge tool could not be started (unknown or not installed).
    MergeToolFailed,
    /// Push refused: the remote branch has commits the local one lacks (action: pull then push).
    PushRejected,
    /// `--force-with-lease` refused: the remote branch moved since it was last fetched.
    StaleLease,
    /// Force push refused on a protected branch (the list is a preference).
    ProtectedBranch,
    /// The remote refused the credentials, or none were available (no prompt is ever shown).
    AuthFailed,
    /// The remote does not exist (no such remote, or no repository at its URL).
    RemoteNotFound,
    /// The remote host could not be reached (DNS, refused or timed out connection).
    HostUnreachable,
    /// The branch has no upstream (pull, or push without `setUpstream`).
    NoUpstream,
    /// `--ff-only` pull or `fastForwardOnly` merge refused: the branches diverged.
    NotFastForward,
    /// The branch asked for does not exist on the remote.
    RemoteBranchNotFound,
    /// The folder to clone into already holds files.
    TargetNotEmpty,
    /// The folder already is a Git repository.
    AlreadyRepository,
    /// The branch is checked out in another worktree: Git refuses to check it out twice.
    BranchInOtherWorktree,
    /// `git worktree remove` refuses: the worktree has local changes (force to discard them).
    WorktreeDirty,
    /// The worktree is locked (`git worktree lock`): unlock it first.
    WorktreeLocked,
    /// The repository uses Git LFS and the `git lfs` command is not installed.
    LfsNotInstalled,
    /// A remote of that name already exists.
    RemoteExists,
    /// A remote name refused by Git (`refs/remotes/<name>/…` must be a valid ref).
    InvalidRemoteName,
    /// The remote refused a tag: one of that name points elsewhere there, or a hook declined it.
    TagRejected,
    /// `undo` with no operation to undo (in this session or a previous one).
    NothingToUndo,
    /// `redo` with no undone operation (or an operation was journaled since).
    NothingToRedo,
    /// The operation cannot be undone or redone locally (push, fetch with prune, pull…);
    /// reason in `payload`.
    UndoBlocked,
    /// Refs or files changed since the operation (in a terminal, or by an operation that is
    /// not journaled): undoing it would lose that change. What moved in `payload`.
    UndoDiverged,
    /// Undoing (or redoing) would overwrite local changes; files in `payload`. Commit or
    /// stash them first.
    UndoWouldOverwrite,
    /// An entry (usually from a previous session) needs objects that are no longer in the
    /// repository, pruned by `git gc` since: it can never be undone or redone. Reason
    /// (`objectsMissing`) in `payload`; nothing was changed.
    UndoObjectsMissing,
    /// Git could not sign the commit (`commit.gpgsign`): no key, a key whose passphrase no
    /// agent provides (yaggui never asks for it), or the signing program failed.
    SigningFailed,
    /// No external diff tool is configured (preference, `diff.tool` or `diff.guitool`).
    DiffToolMissing,
    /// The external diff tool could not be started (unknown or not installed).
    DiffToolFailed,
    /// A branch protected by the preferences is refused by a batch deletion.
    ProtectedBranchDelete,
    /// The branch is checked out in a worktree: it cannot be deleted.
    BranchCheckedOut,
    /// A preferences file (F-326) that cannot be read, is not a yaggui export or holds a value
    /// yaggui refuses. Nothing was changed; the keys at fault are in `detail`.
    PreferencesFileInvalid,
    /// A preferences file written by a newer format version than this yaggui reads.
    PreferencesFileTooNew,
}

/// A user-facing text provided in every supported language.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct LocalizedText {
    pub en: String,
    pub fr: String,
}

impl LocalizedText {
    pub fn new(en: impl Into<String>, fr: impl Into<String>) -> Self {
        Self {
            en: en.into(),
            fr: fr.into(),
        }
    }
}

/// Suggested fix the UI can offer as a button next to the error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ErrorAction {
    /// Add the path to the global `safe.directory` list (`add_safe_directory`), after confirmation.
    AddSafeDirectory { path: String },
    /// Remove a stale `index.lock` (`remove_stale_index_lock`), after confirmation.
    #[serde(rename_all = "camelCase")]
    RemoveIndexLock { repo_id: Option<u32>, path: String },
    /// Install Git or configure its path.
    InstallGit,
    /// Open the command log to see the full Git output.
    OpenCommandLog,
    /// Try the same action again.
    Retry,
    /// Choose the terminal to use (terminal preference).
    ConfigureTerminal,
    /// Set `user.name` / `user.email` (`set_git_identity`), then retry.
    #[serde(rename_all = "camelCase")]
    ConfigureIdentity { repo_id: Option<u32> },
    /// Reload the file list and diffs, then redo the selection.
    Refresh,
    /// Redo the deletion with `force` (`delete_branch`), after confirmation.
    ForceDelete,
    /// Pull (default strategy), then push again.
    PullThenPush,
    /// Push again with `setUpstream`, after confirmation.
    PushSetUpstream,
}

/// Structured data attached to some errors, for a dedicated display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ErrorPayload {
    /// Output of a failed commit whose hook rejected it (a runaway output keeps its beginning and end).
    #[serde(rename_all = "camelCase")]
    Hook {
        /// `pre-commit` or `commit-msg` when only one of them is installed.
        hook: Option<String>,
        /// Exit code of `git commit` (Git does not report the hook's own code).
        exit_code: Option<i32>,
        stdout: String,
        stderr: String,
        /// The middle of a very long output was dropped (marked `[...]`): its beginning and
        /// end are kept.
        truncated: bool,
    },
    /// Why a checkout refuses local changes.
    #[serde(rename_all = "camelCase")]
    DirtyWorktree {
        /// Changed files that the checkout would overwrite (empty when only `clean` refused
        /// them: `canCarry` is then true).
        paths: Vec<String>,
        /// `carry` would succeed.
        can_carry: bool,
    },
    /// Conflicts left by a stash apply or pop.
    #[serde(rename_all = "camelCase")]
    StashConflict {
        /// Conflicted files, now in the working tree with conflict markers.
        paths: Vec<String>,
        /// The stash, kept in the list (`stash@{0}` after a stash-checkout-pop).
        stash_sha: String,
        /// The checkout of a stash-checkout-pop happened before the conflict.
        checked_out: bool,
    },
    /// Why an undo or redo is refused (`undoBlocked`).
    UndoBlocked { reason: UndoBlock },
    /// What changed since the operation (`undoDiverged`), or the local changes an undo or redo
    /// would overwrite (`undoWouldOverwrite`).
    UndoChanges {
        /// Full ref names (`refs/heads/main`, `HEAD`).
        refs: Vec<String>,
        /// Repository-relative paths, sorted.
        paths: Vec<String>,
    },
    /// An operation stopped on conflicts.
    Conflicts {
        /// The operation now in progress, as `repo_state` reports it.
        operation: Option<RepoOperation>,
        /// Conflicted files, sorted.
        paths: Vec<String>,
    },
}

/// The history operations named in messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryOp {
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Reset,
}

impl HistoryOp {
    fn names(self) -> (&'static str, &'static str) {
        match self {
            Self::Merge => ("merge", "le merge"),
            Self::Rebase => ("rebase", "le rebase"),
            Self::CherryPick => ("cherry-pick", "le cherry-pick"),
            Self::Revert => ("revert", "le revert"),
            Self::Reset => ("reset", "le reset"),
        }
    }
}

/// Error returned by every fallible command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct YagguiError {
    pub code: ErrorCode,
    pub message: LocalizedText,
    pub action: Option<ErrorAction>,
    /// Raw technical detail (Git stderr, I/O error), shown in a collapsible area.
    pub detail: Option<String>,
    /// Boxed: rare and large, it would bloat every `Result<_, YagguiError>`.
    pub payload: Option<Box<ErrorPayload>>,
}

impl std::fmt::Display for YagguiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message.en)
    }
}

impl std::error::Error for YagguiError {}

impl YagguiError {
    pub fn new(code: ErrorCode, en: impl Into<String>, fr: impl Into<String>) -> Self {
        Self {
            code,
            message: LocalizedText::new(en, fr),
            action: None,
            detail: None,
            payload: None,
        }
    }

    pub fn with_payload(mut self, payload: ErrorPayload) -> Self {
        self.payload = Some(Box::new(payload));
        self
    }

    pub fn with_action(mut self, action: ErrorAction) -> Self {
        self.action = Some(action);
        self
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        let detail = redact_urls(&detail);
        let trimmed = detail.trim();
        if !trimmed.is_empty() {
            self.detail = Some(trimmed.to_owned());
        }
        self
    }

    pub fn not_implemented() -> Self {
        Self::new(
            ErrorCode::NotImplemented,
            "Not implemented yet.",
            "Pas encore implémenté.",
        )
    }

    pub fn git_not_found() -> Self {
        Self::new(
            ErrorCode::GitNotFound,
            "Git was not found. Install Git 2.30 or later and restart yaggui.",
            "Git est introuvable. Installe Git 2.30 ou plus récent puis relance yaggui.",
        )
        .with_action(ErrorAction::InstallGit)
    }

    /// `detail`: what the system or Git answered when running the binary.
    pub fn git_binary_invalid(path: &str, detail: Option<String>) -> Self {
        Self::new(
            ErrorCode::GitBinaryInvalid,
            format!("\"{path}\" is not a working Git: the file must exist and answer to --version."),
            format!("« {path} » n'est pas un Git utilisable : le fichier doit exister et répondre à --version."),
        )
        .with_detail(detail.unwrap_or_default())
    }

    pub fn preferences_file_invalid(detail: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::PreferencesFileInvalid,
            "This is not a valid yaggui preferences file. Nothing was changed.",
            "Ce n'est pas un fichier de préférences yaggui valide. Rien n'a été modifié. \
             Vérifie que tu as choisi le bon fichier.",
        )
        .with_detail(detail)
    }

    pub fn preferences_file_too_new(found: u32, supported: u32) -> Self {
        Self::new(
            ErrorCode::PreferencesFileTooNew,
            format!(
                "This file uses format version {found}, but this yaggui reads up to version \
                 {supported}. Update yaggui to import it."
            ),
            format!(
                "Ce fichier utilise la version {found} du format, mais cette version de yaggui \
                 lit jusqu'à la version {supported}. Mets yaggui à jour pour l'importer."
            ),
        )
    }

    pub fn remote_branch_not_found(branch: Option<&str>) -> Self {
        let (en, fr) = match branch {
            Some(b) => (
                format!("The branch \"{b}\" does not exist on the remote."),
                format!("La branche « {b} » n'existe pas sur le serveur."),
            ),
            None => (
                "The branch does not exist on the remote.".to_owned(),
                "La branche n'existe pas sur le serveur.".to_owned(),
            ),
        };
        Self::new(ErrorCode::RemoteBranchNotFound, en, fr)
    }

    pub fn target_not_empty(path: &str) -> Self {
        Self::new(
            ErrorCode::TargetNotEmpty,
            format!(
                "The folder {path} already exists and is not empty. Choose another folder, or an empty one."
            ),
            format!(
                "Le dossier {path} existe déjà et n'est pas vide. Choisis un autre dossier, ou un dossier vide."
            ),
        )
    }

    pub fn branch_in_other_worktree(branch: &str, path: Option<&str>) -> Self {
        let (en, fr) = match path {
            Some(path) => (
                format!(
                    "The branch \"{branch}\" is checked out in the worktree {path}: open that worktree, or check out another branch here."
                ),
                format!(
                    "La branche « {branch} » est extraite dans le worktree {path} : ouvre ce worktree, ou extrais une autre branche ici."
                ),
            ),
            None => (
                format!("The branch \"{branch}\" is checked out in another worktree."),
                format!("La branche « {branch} » est extraite dans un autre worktree."),
            ),
        };
        Self::new(ErrorCode::BranchInOtherWorktree, en, fr)
    }

    pub fn worktree_dirty(path: &str) -> Self {
        Self::new(
            ErrorCode::WorktreeDirty,
            format!("The worktree {path} has local changes: removing it would lose them."),
            format!("Le worktree {path} a des modifications locales : le supprimer les perdrait."),
        )
    }

    pub fn worktree_locked(path: &str) -> Self {
        Self::new(
            ErrorCode::WorktreeLocked,
            format!(
                "The worktree {path} is locked. Unlock it (git worktree unlock) before removing it."
            ),
            format!(
                "Le worktree {path} est verrouillé. Déverrouille-le (git worktree unlock) avant de le supprimer."
            ),
        )
    }

    pub fn lfs_not_installed() -> Self {
        Self::new(
            ErrorCode::LfsNotInstalled,
            "Git LFS is not installed: large files stay as pointers. Install Git LFS (git-lfs.com), then run git lfs install.",
            "Git LFS n'est pas installé : les gros fichiers restent des pointeurs. Installe Git LFS (git-lfs.com), puis lance git lfs install.",
        )
    }

    pub fn already_repository(path: &str) -> Self {
        Self::new(
            ErrorCode::AlreadyRepository,
            format!("{path} already is a Git repository."),
            format!("{path} est déjà un dépôt Git."),
        )
    }

    pub fn repo_not_found(path: &str) -> Self {
        Self::new(
            ErrorCode::RepoNotFound,
            format!("The folder {path} does not exist."),
            format!("Le dossier {path} n'existe pas."),
        )
    }

    pub fn not_a_repository(path: &str) -> Self {
        Self::new(
            ErrorCode::NotARepository,
            format!("{path} is not a Git repository."),
            format!("{path} n'est pas un dépôt Git."),
        )
    }

    pub fn unsafe_repository(path: &str) -> Self {
        Self::new(
            ErrorCode::UnsafeRepository,
            format!(
                "Git refuses to use {path} because it belongs to another user. Add it to safe.directory only if you trust it."
            ),
            format!(
                "Git refuse d'utiliser {path} car il appartient à un autre utilisateur. Ajoute-le à safe.directory seulement si tu lui fais confiance."
            ),
        )
        .with_action(ErrorAction::AddSafeDirectory {
            path: path.to_owned(),
        })
    }

    pub fn index_locked(repo_id: Option<u32>, lock_path: &str) -> Self {
        Self::new(
            ErrorCode::IndexLocked,
            "Another Git process is using this repository (index.lock). If no Git process is running, the lock is left over from a crash and can be removed.",
            "Un autre processus Git utilise ce dépôt (index.lock). Si aucun processus Git ne tourne, le verrou provient d'un crash et peut être supprimé.",
        )
        .with_action(ErrorAction::RemoveIndexLock {
            repo_id,
            path: lock_path.to_owned(),
        })
    }

    pub fn repo_not_open(repo_id: u32) -> Self {
        Self::new(
            ErrorCode::RepoNotOpen,
            format!("Repository #{repo_id} is not open."),
            format!("Le dépôt n°{repo_id} n'est pas ouvert."),
        )
    }

    pub fn op_not_found(op_id: u32) -> Self {
        Self::new(
            ErrorCode::OpNotFound,
            format!("Operation #{op_id} is not running."),
            format!("L'opération n°{op_id} n'est pas en cours."),
        )
    }

    pub fn revision_not_found(rev: &str) -> Self {
        Self::new(
            ErrorCode::RevisionNotFound,
            format!("No commit matches \"{rev}\"."),
            format!("Aucun commit ne correspond à « {rev} »."),
        )
    }

    pub fn cancelled() -> Self {
        Self::new(
            ErrorCode::Cancelled,
            "Operation cancelled.",
            "Opération annulée.",
        )
    }

    pub fn invalid_argument(en: impl Into<String>, fr: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArgument, en, fr)
    }

    pub fn storage(detail: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::Storage,
            "yaggui could not read or write its local data.",
            "yaggui n'a pas pu lire ou écrire ses données locales.",
        )
        .with_detail(detail)
    }

    pub fn internal(detail: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::Internal,
            "Unexpected error.",
            "Erreur inattendue.",
        )
        .with_detail(detail)
    }

    pub fn update_check_failed(detail: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::UpdateCheckFailed,
            "Could not check for updates.",
            "Impossible de vérifier les mises à jour.",
        )
        .with_detail(detail)
        .with_action(ErrorAction::Retry)
    }

    pub fn update_install_failed(detail: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::UpdateInstallFailed,
            "The update could not be installed.",
            "La mise à jour n'a pas pu être installée.",
        )
        .with_detail(detail)
        .with_action(ErrorAction::Retry)
    }

    pub fn avatar_unavailable(detail: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::AvatarUnavailable,
            "The avatar could not be downloaded.",
            "L'avatar n'a pas pu être téléchargé.",
        )
        .with_detail(detail)
    }

    pub fn watch_unavailable(detail: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::WatchUnavailable,
            "Automatic refresh is unavailable for this repository (the system limit on watched files may be reached). Changes made outside yaggui will show after a manual refresh.",
            "Le rafraîchissement automatique est indisponible pour ce dépôt (la limite système de fichiers surveillés est peut-être atteinte). Les changements faits hors de yaggui apparaîtront après un rafraîchissement manuel.",
        )
        .with_detail(detail)
    }

    /// `configured` is the terminal preference, if one is set.
    pub fn editor_not_found(configured: Option<&str>) -> Self {
        let error = match configured {
            Some(name) => Self::new(
                ErrorCode::EditorNotFound,
                format!(
                    "The editor \"{name}\" could not be started. Check its name in the preferences."
                ),
                format!(
                    "L'éditeur « {name} » n'a pas pu être lancé. Vérifie son nom dans les préférences."
                ),
            ),
            None => Self::new(
                ErrorCode::EditorNotFound,
                "No application could open the file. Choose an editor in the preferences.",
                "Aucune application n'a pu ouvrir le fichier. Choisis un éditeur dans les préférences.",
            ),
        };
        error.with_action(ErrorAction::Retry)
    }

    pub fn file_manager_failed() -> Self {
        Self::new(
            ErrorCode::FileManagerFailed,
            "The file manager could not open the repository folder.",
            "Le gestionnaire de fichiers n'a pas pu ouvrir le dossier du dépôt.",
        )
    }

    pub fn terminal_not_found(configured: Option<&str>) -> Self {
        match configured {
            Some(name) => Self::new(
                ErrorCode::TerminalNotFound,
                format!("The terminal \"{name}\" could not be started. Check its name in the terminal setting."),
                format!("Le terminal « {name} » n'a pas pu être lancé. Vérifie son nom dans le réglage du terminal."),
            ),
            None => Self::new(
                ErrorCode::TerminalNotFound,
                "No terminal was found on this system. Choose the one to use in the terminal setting.",
                "Aucun terminal n'a été trouvé sur ce système. Choisis celui à utiliser dans le réglage du terminal.",
            ),
        }
        .with_action(ErrorAction::ConfigureTerminal)
    }

    pub fn shell_failed(shell: &str, detail: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::ShellFailed,
            format!("The shell \"{shell}\" could not be started in the integrated terminal."),
            format!("Le shell « {shell} » n'a pas pu être lancé dans le terminal intégré."),
        )
        .with_detail(detail)
    }

    pub fn terminal_closed(pty_id: u32) -> Self {
        Self::new(
            ErrorCode::TerminalClosed,
            "This terminal is closed: open a new one.",
            "Ce terminal est fermé : ouvres-en un nouveau.",
        )
        .with_detail(format!("pty {pty_id}"))
    }

    pub fn nothing_to_commit() -> Self {
        Self::new(
            ErrorCode::NothingToCommit,
            "Nothing to commit: stage changes first.",
            "Rien à commiter : stage d'abord des modifications.",
        )
    }

    pub fn identity_unknown(repo_id: Option<u32>) -> Self {
        Self::new(
            ErrorCode::IdentityUnknown,
            "Git does not know who you are: set your name and email (user.name, user.email) to commit.",
            "Git ne sait pas qui tu es : renseigne ton nom et ton e-mail (user.name, user.email) pour commiter.",
        )
        .with_action(ErrorAction::ConfigureIdentity { repo_id })
    }

    /// `passphrase`: the key needs a passphrase that no agent (gpg-agent, ssh-agent) gave.
    pub fn signing_failed(passphrase: bool) -> Self {
        let (en, fr) = if passphrase {
            (
                "The signing key needs its passphrase and no agent provided it. yaggui never asks for it: unlock the key in gpg-agent or ssh-agent (ssh-add), or commit from a terminal.",
                "La clé de signature demande sa phrase de passe et aucun agent ne l'a fournie. yaggui ne la demande jamais : déverrouille la clé dans gpg-agent ou ssh-agent (ssh-add), ou commite depuis un terminal.",
            )
        } else {
            (
                "Git could not sign the commit. Check the signing key (user.signingkey, gpg.format) or turn signing off (commit.gpgsign).",
                "Git n'a pas pu signer le commit. Vérifie la clé de signature (user.signingkey, gpg.format) ou désactive la signature (commit.gpgsign).",
            )
        };
        Self::new(ErrorCode::SigningFailed, en, fr).with_action(ErrorAction::OpenCommandLog)
    }

    pub fn hook_failed(
        hook: Option<&str>,
        exit_code: Option<i32>,
        stdout: String,
        stderr: String,
        truncated: bool,
    ) -> Self {
        let (en, fr) = match hook {
            Some(name) => (
                format!("The {name} hook rejected the commit. Its output explains why."),
                format!("Le hook {name} a refusé le commit. Sa sortie explique pourquoi."),
            ),
            None => (
                "A Git hook rejected the commit. Its output explains why.".to_owned(),
                "Un hook Git a refusé le commit. Sa sortie explique pourquoi.".to_owned(),
            ),
        };
        Self::new(ErrorCode::HookFailed, en, fr).with_payload(ErrorPayload::Hook {
            hook: hook.map(str::to_owned),
            exit_code,
            stdout,
            stderr,
            truncated,
        })
    }

    pub fn stale_diff(path: &str) -> Self {
        Self::new(
            ErrorCode::StaleDiff,
            format!("{path} changed since its diff was shown. Refresh and select again."),
            format!("{path} a changé depuis l'affichage de son diff. Rafraîchis puis refais la sélection."),
        )
        .with_action(ErrorAction::Refresh)
    }

    pub fn file_changed(path: &str) -> Self {
        Self::new(
            ErrorCode::FileChanged,
            format!("{path} changed on disk since it was opened."),
            format!("{path} a changé sur le disque depuis son ouverture."),
        )
    }

    pub fn unresolved_conflicts() -> Self {
        Self::new(
            ErrorCode::UnresolvedConflicts,
            "Some files are still in conflict: resolve them (and stage them) first.",
            "Des fichiers sont encore en conflit : résous-les (et stage-les) d'abord.",
        )
    }

    pub fn path_too_long() -> Self {
        Self::new(
            ErrorCode::PathTooLong,
            "A path is too long for Windows. Enable long paths with `git config --global core.longpaths true`, then retry.",
            "Un chemin est trop long pour Windows. Active les chemins longs avec `git config --global core.longpaths true`, puis recommence.",
        )
        .with_action(ErrorAction::OpenCommandLog)
    }

    pub fn detached_head() -> Self {
        Self::new(
            ErrorCode::DetachedHead,
            "HEAD is detached (no current branch): check out a branch first.",
            "HEAD est détaché (aucune branche courante) : fais d'abord un checkout d'une branche.",
        )
    }

    pub fn invalid_ref_name(name: &str, tag: bool) -> Self {
        let (en, fr) = if tag {
            ("tag", "tag")
        } else {
            ("branch", "branche")
        };
        Self::new(
            ErrorCode::InvalidRefName,
            format!(
                "\"{name}\" is not a valid {en} name: no spaces, no ~ ^ : ? * [ \\, no \"..\", and it cannot start with \"-\" or end with \"/\", \".\" or \".lock\"."
            ),
            format!(
                "« {name} » n'est pas un nom de {fr} valide : pas d'espace, ni ~ ^ : ? * [ \\, ni « .. », et il ne peut pas commencer par « - » ni finir par « / », « . » ou « .lock »."
            ),
        )
    }

    pub fn ref_exists(name: &str, tag: bool) -> Self {
        if tag {
            Self::new(
                ErrorCode::RefExists,
                format!("A tag named \"{name}\" already exists."),
                format!("Un tag « {name} » existe déjà."),
            )
        } else {
            Self::new(
                ErrorCode::RefExists,
                format!("A branch named \"{name}\" already exists."),
                format!("Une branche « {name} » existe déjà."),
            )
        }
    }

    pub fn dirty_worktree(paths: Vec<String>, can_carry: bool) -> Self {
        let (en, fr) = if can_carry {
            (
                "You have local changes. Stash them, or bring them along to the other branch.",
                "Tu as des modifications locales. Mets-les de côté (stash) ou emporte-les sur l'autre branche.",
            )
        } else {
            (
                "Your local changes would be overwritten by the checkout. Stash them first (stash, checkout, then pop).",
                "Tes modifications locales seraient écrasées par le checkout. Mets-les d'abord de côté (stash, checkout puis pop).",
            )
        };
        Self::new(ErrorCode::DirtyWorktree, en, fr)
            .with_payload(ErrorPayload::DirtyWorktree { paths, can_carry })
    }

    pub fn branch_not_merged(name: &str) -> Self {
        Self::new(
            ErrorCode::BranchNotMerged,
            format!("The branch \"{name}\" is not fully merged: deleting it can lose commits. Force the deletion only if you no longer need them."),
            format!("La branche « {name} » n'est pas entièrement mergée : la supprimer peut perdre des commits. Force la suppression seulement si tu n'en as plus besoin."),
        )
        .with_action(ErrorAction::ForceDelete)
    }

    pub fn current_branch(name: &str) -> Self {
        Self::new(
            ErrorCode::CurrentBranch,
            format!(
                "\"{name}\" is the current branch: check out another branch before deleting it."
            ),
            format!(
                "« {name} » est la branche courante : fais d'abord un checkout d'une autre branche pour la supprimer."
            ),
        )
    }

    pub fn stash_conflict(paths: Vec<String>, stash_sha: String, checked_out: bool) -> Self {
        let (en, fr) = if checked_out {
            (
                "The checkout is done, but your stashed changes conflict with this branch. Resolve the conflicts; the stash is kept, drop it once you are done.",
                "Le checkout est fait, mais tes modifications mises de côté entrent en conflit avec cette branche. Résous les conflits ; le stash est conservé, supprime-le quand tu as fini.",
            )
        } else {
            (
                "The stash conflicts with your files. Resolve the conflicts; the stash is kept, drop it once you are done.",
                "Le stash entre en conflit avec tes fichiers. Résous les conflits ; le stash est conservé, supprime-le quand tu as fini.",
            )
        };
        Self::new(ErrorCode::StashConflict, en, fr).with_payload(ErrorPayload::StashConflict {
            paths,
            stash_sha,
            checked_out,
        })
    }

    pub fn nothing_to_stash() -> Self {
        Self::new(
            ErrorCode::NothingToStash,
            "Nothing to stash: you have no local changes.",
            "Rien à mettre de côté : tu n'as aucune modification locale.",
        )
    }

    pub fn stale_refs() -> Self {
        Self::new(
            ErrorCode::StaleRefs,
            "The branches or stashes changed in the meantime. Refresh and try again.",
            "Les branches ou les stashes ont changé entre-temps. Rafraîchis puis réessaie.",
        )
        .with_action(ErrorAction::Refresh)
    }

    /// Local changes block a history operation (code `dirtyWorktree`, never carried).
    pub fn local_changes(op: HistoryOp, paths: Vec<String>) -> Self {
        let (en, fr) = op.names();
        Self::new(
            ErrorCode::DirtyWorktree,
            format!("Your local changes would be overwritten by the {en}. Commit or stash them first."),
            format!("Tes modifications locales seraient écrasées par {fr}. Commite-les ou mets-les de côté (stash) d'abord."),
        )
        .with_payload(ErrorPayload::DirtyWorktree {
            paths,
            can_carry: false,
        })
    }

    pub fn conflicts(operation: Option<RepoOperation>, paths: Vec<String>) -> Self {
        let (en, fr) = match &operation {
            Some(RepoOperation::Rebase { .. }) => (
                "The rebase stopped on conflicts. Resolve them, then continue (or skip this commit, or abort the rebase).",
                "Le rebase s'est arrêté sur des conflits. Résous-les puis continue (ou passe ce commit, ou annule le rebase).",
            ),
            Some(RepoOperation::CherryPick) => (
                "The cherry-pick stopped on conflicts. Resolve them, then continue (or skip this commit, or abort).",
                "Le cherry-pick s'est arrêté sur des conflits. Résous-les puis continue (ou passe ce commit, ou annule).",
            ),
            Some(RepoOperation::Revert) => (
                "The revert stopped on conflicts. Resolve them, then continue (or abort).",
                "Le revert s'est arrêté sur des conflits. Résous-les puis continue (ou annule).",
            ),
            _ => (
                "The merge stopped on conflicts. Resolve them, then continue to create the merge commit (or abort the merge).",
                "Le merge s'est arrêté sur des conflits. Résous-les puis continue pour créer le commit de merge (ou annule le merge).",
            ),
        };
        Self::new(ErrorCode::Conflicts, en, fr)
            .with_payload(ErrorPayload::Conflicts { operation, paths })
    }

    /// A `fastForwardOnly` merge of `source` refused (`not_fast_forward` is the pull's).
    pub fn merge_not_fast_forward(source: &str) -> Self {
        Self::new(
            ErrorCode::NotFastForward,
            format!(
                "The branches have diverged: \"{source}\" cannot be fast-forwarded. Merge with a merge commit, or rebase."
            ),
            format!(
                "Les branches ont divergé : impossible d'avancer rapidement (fast-forward) vers « {source} ». Fais un merge avec commit de merge, ou un rebase."
            ),
        )
    }

    pub fn mainline_required(sha: &str) -> Self {
        let short = sha.get(..7).unwrap_or(sha);
        Self::new(
            ErrorCode::MainlineRequired,
            format!("{short} is a merge commit: choose which parent's side to keep."),
            format!(
                "{short} est un commit de merge : choisis le parent dont le côté est conservé."
            ),
        )
    }

    pub fn empty_commit(sha: Option<&str>) -> Self {
        let short = sha.map(|s| s.get(..7).unwrap_or(s));
        let (en, fr) = match short {
            Some(short) => (
                format!("{short} brings no change any more (it is probably already applied): skip it."),
                format!("{short} n'apporte plus aucune modification (il est sans doute déjà appliqué) : passe-le."),
            ),
            None => (
                "This commit brings no change any more (it is probably already applied): skip it.".to_owned(),
                "Ce commit n'apporte plus aucune modification (il est sans doute déjà appliqué) : passe-le.".to_owned(),
            ),
        };
        Self::new(ErrorCode::EmptyCommit, en, fr)
    }

    pub fn no_operation() -> Self {
        Self::new(
            ErrorCode::NoOperation,
            "No merge, rebase, cherry-pick or revert is in progress.",
            "Aucun merge, rebase, cherry-pick ni revert n'est en cours.",
        )
        .with_action(ErrorAction::Refresh)
    }

    pub fn merge_tool_missing() -> Self {
        Self::new(
            ErrorCode::MergeToolMissing,
            "No external merge tool is configured: set merge.tool in your Git configuration.",
            "Aucun outil de merge externe n'est configuré : renseigne merge.tool dans ta configuration Git.",
        )
    }

    pub fn merge_tool_failed(tool: &str) -> Self {
        Self::new(
            ErrorCode::MergeToolFailed,
            format!(
                "The merge tool \"{tool}\" could not be started. Check that it is installed and configured (mergetool.{tool}.cmd)."
            ),
            format!(
                "L'outil de merge « {tool} » n'a pas pu être lancé. Vérifie qu'il est installé et configuré (mergetool.{tool}.cmd)."
            ),
        )
    }

    pub fn diff_tool_missing() -> Self {
        Self::new(
            ErrorCode::DiffToolMissing,
            "No external diff tool is configured: choose one in the preferences (Tools) or set diff.tool in your Git configuration.",
            "Aucun outil de diff externe n'est configuré : choisis-en un dans les préférences (Outils) ou renseigne diff.tool dans ta configuration Git.",
        )
    }

    pub fn diff_tool_failed(tool: &str) -> Self {
        Self::new(
            ErrorCode::DiffToolFailed,
            format!(
                "The diff tool \"{tool}\" could not be started. Check that it is installed and configured (difftool.{tool}.cmd)."
            ),
            format!(
                "L'outil de diff « {tool} » n'a pas pu être lancé. Vérifie qu'il est installé et configuré (difftool.{tool}.cmd)."
            ),
        )
        .with_action(ErrorAction::OpenCommandLog)
    }

    pub fn protected_branch_delete(name: &str) -> Self {
        Self::new(
            ErrorCode::ProtectedBranchDelete,
            format!(
                "\"{name}\" is a protected branch: the cleanup never deletes it. Delete it on its own if you really mean to."
            ),
            format!(
                "« {name} » est une branche protégée : le nettoyage ne la supprime jamais. Supprime-la seule si c'est vraiment voulu."
            ),
        )
    }

    pub fn branch_checked_out(name: &str) -> Self {
        Self::new(
            ErrorCode::BranchCheckedOut,
            format!("\"{name}\" is checked out in a worktree: it cannot be deleted."),
            format!("« {name} » est extraite dans un worktree : elle ne peut pas être supprimée."),
        )
    }

    pub fn operation_in_progress() -> Self {
        Self::new(
            ErrorCode::OperationInProgress,
            "Another operation (merge, rebase, cherry-pick, revert or bisect) is in progress: continue or abort it first.",
            "Une autre opération (merge, rebase, cherry-pick, revert ou bisect) est en cours : continue-la ou annule-la d'abord.",
        )
    }

    pub fn push_rejected() -> Self {
        Self::new(
            ErrorCode::PushRejected,
            "Push rejected: the remote branch has commits you don't have.",
            "Push rejeté : la branche distante contient des commits que tu n'as pas.",
        )
        .with_action(ErrorAction::PullThenPush)
    }

    pub fn stale_lease() -> Self {
        Self::new(
            ErrorCode::StaleLease,
            "Force push refused: the remote branch moved since your last fetch. Fetch and check what would be overwritten.",
            "Force push refusé : la branche distante a bougé depuis ton dernier fetch. Fais un fetch et vérifie ce qui serait écrasé.",
        )
    }

    pub fn protected_branch(name: &str) -> Self {
        Self::new(
            ErrorCode::ProtectedBranch,
            format!("\"{name}\" is a protected branch: force push is refused."),
            format!("« {name} » est une branche protégée : le force push est refusé."),
        )
    }

    pub fn auth_failed(ssh: bool) -> Self {
        if ssh {
            Self::new(
                ErrorCode::AuthFailed,
                "SSH authentication failed. Load your key in ssh-agent (ssh-add) and check that the remote knows it.",
                "Authentification SSH refusée. Charge ta clé dans ssh-agent (ssh-add) et vérifie que le remote la connaît.",
            )
        } else {
            Self::new(
                ErrorCode::AuthFailed,
                "Authentication failed. yaggui never asks for passwords: configure a Git credential helper (git config credential.helper) and sign in once from a terminal.",
                "Authentification refusée. yaggui ne demande jamais de mot de passe : configure un credential helper Git (git config credential.helper) et connecte-toi une fois depuis un terminal.",
            )
        }
    }

    pub fn remote_not_found() -> Self {
        Self::new(
            ErrorCode::RemoteNotFound,
            "Remote not found: check its name and URL.",
            "Remote introuvable : vérifie son nom et son URL.",
        )
    }

    pub fn remote_exists(name: &str) -> Self {
        Self::new(
            ErrorCode::RemoteExists,
            format!("A remote named \"{name}\" already exists."),
            format!("Un remote nommé « {name} » existe déjà."),
        )
    }

    pub fn invalid_remote_name(name: &str) -> Self {
        Self::new(
            ErrorCode::InvalidRemoteName,
            format!(
                "\"{name}\" is not a valid remote name: no spaces, no leading dash, none of ~ ^ : ? * [ \\."
            ),
            format!(
                "« {name} » n'est pas un nom de remote valide : pas d'espace, pas de tiret au début, aucun de ~ ^ : ? * [ \\."
            ),
        )
    }

    /// `names`: the refused tags. `exists`: a tag of that name points elsewhere on the remote
    /// (else a hook or a server rule declined it).
    pub fn tag_rejected(names: &[String], exists: bool) -> Self {
        let list = names.join(", ");
        let (en, fr) = match (exists, names.len()) {
            (true, 1) => (
                format!(
                    "The remote refused the tag {list}: a tag of that name already exists there and points to another commit. Delete the remote tag first, or rename yours."
                ),
                format!(
                    "Le remote a refusé le tag {list} : un tag de ce nom y existe déjà et pointe vers un autre commit. Supprime d'abord le tag distant, ou renomme le tien."
                ),
            ),
            (true, _) => (
                format!(
                    "The remote refused the tags {list}: tags of those names already exist there and point to other commits. The other tags were pushed."
                ),
                format!(
                    "Le remote a refusé les tags {list} : des tags de ces noms y existent déjà et pointent vers d'autres commits. Les autres tags ont été poussés."
                ),
            ),
            (false, _) => (
                format!(
                    "The remote refused the tag {list} (server rule or hook). See the command log for its answer."
                ),
                format!(
                    "Le remote a refusé le tag {list} (règle du serveur ou hook). Le journal des commandes montre sa réponse."
                ),
            ),
        };
        Self::new(ErrorCode::TagRejected, en, fr).with_action(ErrorAction::OpenCommandLog)
    }

    pub fn host_unreachable() -> Self {
        Self::new(
            ErrorCode::HostUnreachable,
            "The remote host can't be reached. Check your connection and the remote URL.",
            "L'hôte distant est injoignable. Vérifie ta connexion et l'URL du remote.",
        )
        .with_action(ErrorAction::Retry)
    }

    pub fn no_upstream(branch: &str) -> Self {
        Self::new(
            ErrorCode::NoUpstream,
            format!("\"{branch}\" has no upstream branch."),
            format!("« {branch} » n'a pas de branche amont (upstream)."),
        )
        .with_action(ErrorAction::PushSetUpstream)
    }

    pub fn not_fast_forward() -> Self {
        Self::new(
            ErrorCode::NotFastForward,
            "Your branch and its upstream diverged: a fast-forward is impossible. Pull with merge or rebase.",
            "Ta branche et son upstream ont divergé : impossible d'avancer en fast-forward. Fais un pull en merge ou en rebase.",
        )
    }

    /// A pull stopped on conflicts: [`Self::conflicts`] with the pull named in the message.
    pub fn pull_conflicts(operation: RepoOperation, paths: Vec<String>) -> Self {
        let (en, fr) = if matches!(operation, RepoOperation::Rebase { .. }) {
            (
                "The pull stopped on conflicts: the rebase is in progress. Resolve them, then continue (or skip this commit, or abort the rebase).",
                "Le pull s'est arrêté sur des conflits : le rebase est en cours. Résous-les puis continue (ou passe ce commit, ou annule le rebase).",
            )
        } else {
            (
                "The pull stopped on conflicts: the merge is in progress. Resolve them, then continue to create the merge commit (or abort the merge).",
                "Le pull s'est arrêté sur des conflits : le merge est en cours. Résous-les puis continue pour créer le commit de merge (ou annule le merge).",
            )
        };
        Self::new(ErrorCode::Conflicts, en, fr).with_payload(ErrorPayload::Conflicts {
            operation: Some(operation),
            paths,
        })
    }

    pub fn nothing_to_undo() -> Self {
        Self::new(
            ErrorCode::NothingToUndo,
            "Nothing to undo.",
            "Rien à annuler.",
        )
    }

    pub fn nothing_to_redo() -> Self {
        Self::new(
            ErrorCode::NothingToRedo,
            "Nothing to redo.",
            "Rien à rétablir.",
        )
    }

    pub fn undo_blocked(reason: UndoBlock) -> Self {
        let (en, fr) = match &reason {
            UndoBlock::Published => (
                "This operation changed a remote: it cannot be undone locally.",
                "Cette opération a modifié un remote : elle ne peut pas être annulée localement.",
            ),
            UndoBlock::Pruned => (
                "A fetch with prune cannot be undone: the deleted remote-tracking branches come back with the next fetch if they still exist.",
                "Un fetch avec prune ne peut pas être annulé : les branches distantes supprimées reviennent au prochain fetch si elles existent encore.",
            ),
            UndoBlock::Pulled => (
                "A pull cannot be undone: what it fetched stays. Reset the branch instead if needed.",
                "Un pull ne peut pas être annulé : ce qu'il a récupéré reste. Fais plutôt un reset de la branche si besoin.",
            ),
            UndoBlock::Downloaded => (
                "This operation downloaded and checked out content (LFS files, submodule commits): it cannot be undone.",
                "Cette opération a téléchargé et extrait du contenu (fichiers LFS, commits de submodules) : elle ne peut pas être annulée.",
            ),
            UndoBlock::FilesDeleted => (
                "The worktree was removed with its local changes: they cannot be brought back.",
                "Le worktree a été supprimé avec ses modifications locales : elles ne peuvent pas être restaurées.",
            ),
            UndoBlock::NotRecorded => (
                "The state before this operation could not be recorded: it cannot be undone.",
                "L'état d'avant cette opération n'a pas pu être enregistré : elle ne peut pas être annulée.",
            ),
            UndoBlock::Unreadable => (
                "This operation was recorded by another version of yaggui and cannot be read: it cannot be undone. Use the reflog to find the earlier state if you need it.",
                "Cette opération a été enregistrée par une autre version de yaggui et ne peut pas être lue : elle ne peut pas être annulée. Passe par le reflog pour retrouver l'état d'avant si besoin.",
            ),
            UndoBlock::Diverged { refs } => {
                return Self::undo_diverged(refs.clone(), Vec::new());
            }
            UndoBlock::ObjectsMissing { count } => return Self::undo_objects_missing(*count),
        };
        Self::new(ErrorCode::UndoBlocked, en, fr).with_payload(ErrorPayload::UndoBlocked { reason })
    }

    pub fn undo_diverged(refs: Vec<String>, paths: Vec<String>) -> Self {
        Self::new(
            ErrorCode::UndoDiverged,
            "The repository changed since this operation (branches or files modified elsewhere): undoing it would lose that change.",
            "Le dépôt a changé depuis cette opération (branches ou fichiers modifiés ailleurs) : l'annuler perdrait ce changement.",
        )
        .with_payload(ErrorPayload::UndoChanges { refs, paths })
        .with_action(ErrorAction::Refresh)
    }

    /// What a step needs was pruned (`git gc`): refused before anything changed.
    pub fn undo_objects_missing(count: u32) -> Self {
        Self::new(
            ErrorCode::UndoObjectsMissing,
            "Git deleted what this undo needs (old commits or saved file contents, removed by a garbage collection since): it can no longer be undone. Nothing was changed; redo the change by hand if you still need it.",
            "Git a supprimé ce dont cette annulation a besoin (anciens commits ou contenus de fichiers sauvegardés, effacés par un nettoyage depuis) : elle ne peut plus être annulée. Rien n'a été modifié ; refais le changement à la main si tu en as encore besoin.",
        )
        .with_payload(ErrorPayload::UndoBlocked {
            reason: UndoBlock::ObjectsMissing { count },
        })
    }

    pub fn undo_would_overwrite(paths: Vec<String>) -> Self {
        Self::new(
            ErrorCode::UndoWouldOverwrite,
            "Your local changes would be overwritten. Commit or stash them first.",
            "Tes modifications locales seraient écrasées. Commite-les ou mets-les de côté (stash) d'abord.",
        )
        .with_payload(ErrorPayload::UndoChanges {
            refs: Vec::new(),
            paths,
        })
    }

    pub fn git_failed(stderr: &str) -> Self {
        Self::new(
            ErrorCode::GitFailed,
            "The Git command failed.",
            "La commande Git a échoué.",
        )
        .with_action(ErrorAction::OpenCommandLog)
        .with_detail(stderr)
    }
}

type BoxError = Box<dyn std::error::Error + Send + Sync + 'static>;

/// Internal failures (gix, I/O, SQLite…). They keep their cause chain and become a
/// `YagguiError` at the service boundary, with the chain in `detail`.
#[derive(Debug, thiserror::Error)]
pub enum BackendError {
    #[error("{context}")]
    Gix {
        context: &'static str,
        #[source]
        source: BoxError,
    },
    #[error("{context}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
    #[error("database error")]
    Sqlite(#[from] rusqlite::Error),
    #[error("cannot encode a stored value")]
    Json(#[from] serde_json::Error),
    #[error("cannot watch the repository")]
    Watch(#[from] notify::Error),
    #[error("{context}")]
    Task {
        context: &'static str,
        #[source]
        source: BoxError,
    },
    /// A broken internal invariant (worker gone, panicked job…).
    #[error("{0}")]
    Invariant(String),
}

impl BackendError {
    pub fn gix(context: &'static str, source: impl Into<BoxError>) -> Self {
        Self::Gix {
            context,
            source: source.into(),
        }
    }

    pub fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        Self::Io {
            context: context.into(),
            source,
        }
    }

    pub fn task(context: &'static str, source: impl Into<BoxError>) -> Self {
        Self::Task {
            context,
            source: source.into(),
        }
    }

    /// `"outer: inner: root cause"`, as shown in the error details.
    pub fn chain(&self) -> String {
        let mut text = self.to_string();
        let mut source = std::error::Error::source(self);
        while let Some(cause) = source {
            text.push_str(": ");
            text.push_str(&cause.to_string());
            source = cause.source();
        }
        text
    }
}

impl From<BackendError> for YagguiError {
    fn from(err: BackendError) -> Self {
        tracing::warn!(error = %err.chain(), "backend error");
        match err {
            BackendError::Sqlite(_) => YagguiError::storage(err.chain()),
            BackendError::Watch(_) => YagguiError::watch_unavailable(err.chain()),
            _ => YagguiError::internal(err.chain()),
        }
    }
}

impl From<rusqlite::Error> for YagguiError {
    fn from(err: rusqlite::Error) -> Self {
        BackendError::from(err).into()
    }
}

/// Maps the stderr of a failed Git command to a catalog error.
/// `cwd` is the directory the command ran in, used to fill in actions.
pub fn classify_git_failure(
    stderr: &str,
    stdout: &str,
    cwd: Option<&str>,
    repo_id: Option<u32>,
) -> YagguiError {
    let lower = stderr.to_ascii_lowercase();
    // `git commit` reports an empty commit on stdout.
    let lower_out = stdout.to_ascii_lowercase();
    let path = cwd.unwrap_or_default();
    let any = |patterns: &[&str]| patterns.iter().any(|p| lower.contains(p));

    let error = if lower.contains("detected dubious ownership") {
        let unsafe_path = extract_dubious_path(stderr).unwrap_or_else(|| path.to_owned());
        YagguiError::unsafe_repository(&unsafe_path)
    } else if lower.contains("index.lock") && lower.contains("file exists") {
        let lock = extract_quoted(stderr, "index.lock").unwrap_or_else(|| path.to_owned());
        YagguiError::index_locked(repo_id, &lock)
    } else if lower.contains("cannot do a soft reset in the middle of a merge") {
        YagguiError::operation_in_progress()
    } else if lower.contains("'lfs' is not a git command") {
        YagguiError::lfs_not_installed()
    } else if let Some((branch, other)) = extract_other_worktree(stderr) {
        YagguiError::branch_in_other_worktree(&branch, Some(&other))
    } else if lower.contains("contains modified or untracked files") {
        YagguiError::worktree_dirty(extract_quoted(stderr, "").as_deref().unwrap_or(path))
    } else if lower.contains("cannot remove a locked working tree") {
        YagguiError::worktree_locked(path)
    } else if lower.contains("not a git repository") {
        YagguiError::not_a_repository(path)
    } else if lower.contains("remote branch") && lower.contains("not found in upstream") {
        let branch = lower
            .find("remote branch ")
            .map(|at| &stderr[at + "remote branch ".len()..])
            .and_then(|rest| rest.split_whitespace().next())
            .map(str::to_owned);
        YagguiError::remote_branch_not_found(branch.as_deref())
    } else if lower.contains("already exists and is not an empty directory") {
        YagguiError::target_not_empty(extract_quoted(stderr, "").as_deref().unwrap_or(path))
    } else if any(&[
        "please tell me who you are",
        "unable to auto-detect email address",
        "empty ident name",
        "no email was given and auto-detection is disabled",
        "no name was given and auto-detection is disabled",
    ]) {
        YagguiError::identity_unknown(repo_id)
    } else if let Some(passphrase) = signing_failure(&lower) {
        YagguiError::signing_failed(passphrase)
    } else if any(&[
        "unmerged files",
        "resolve your current index first",
        "is unmerged",
        "you have unmerged paths",
    ]) {
        YagguiError::unresolved_conflicts()
    } else if lower.lines().any(|line| {
        line.starts_with("error: patch failed:")
            || (line.starts_with("error: ") && line.ends_with(": patch does not apply"))
            || line.starts_with("error: while searching for:")
    }) {
        let file = extract_after(stderr, "patch failed: ").unwrap_or_default();
        YagguiError::stale_diff(&file)
    } else if lower.contains("filename too long") {
        // Git for Windows without `core.longpaths` (`error: unable to create file …: Filename
        // too long`, `fatal: cannot create directory at '…': Filename too long`).
        YagguiError::path_too_long()
    } else if lower.contains("error: remote ") && lower.contains(" already exists") {
        let name = extract_between(stderr, "remote ", " already exists").unwrap_or_default();
        YagguiError::remote_exists(&name)
    } else if lower.contains("is not a valid remote name") {
        YagguiError::invalid_remote_name(&extract_quoted(stderr, "").unwrap_or_default())
    } else if let Some(error) = classify_network_failure(&lower) {
        error
    } else if lower.contains("you are not currently on a branch") {
        YagguiError::detached_head()
    } else if [
        "nothing to commit",
        "no changes added to commit",
        "nothing added to commit",
    ]
    .iter()
    .any(|p| lower_out.contains(p) || lower.contains(p))
    {
        YagguiError::nothing_to_commit()
    } else {
        return YagguiError::git_failed(stderr);
    };
    error.with_detail(stderr)
}

/// A failure to sign a commit or tag: `Some(true)` when it is about a passphrase.
fn signing_failure(lower: &str) -> Option<bool> {
    let any = |patterns: &[&str]| patterns.iter().any(|p| lower.contains(p));
    let signing = any(&[
        "gpg failed to sign the data",
        "failed to sign the data",
        "couldn't load public key",
        "user.signingkey or gpg.ssh.defaultkeycommand",
        "failed to get the ssh fingerprint",
        "ssh-keygen -y sign is needed",
        "signing failed:",
    ]) || (lower.contains("load key")
        && lower.contains("failed to write commit object"));
    signing.then(|| {
        any(&[
            "passphrase",
            "pinentry",
            "inappropriate ioctl for device",
            "no agent running",
            "operation cancelled",
        ])
    })
}

/// Push refusals, authentication and connection failures (fetch, pull, push).
fn classify_network_failure(lower: &str) -> Option<YagguiError> {
    let any = |patterns: &[&str]| patterns.iter().any(|p| lower.contains(p));
    Some(if lower.contains("(stale info)") {
        YagguiError::stale_lease()
    } else if lower.contains("[rejected]")
        && any(&["(non-fast-forward)", "(fetch first)", "(already exists)"])
        || lower.contains("updates were rejected because")
    {
        YagguiError::push_rejected()
    } else if any(&[
        "permission denied (publickey",
        "permission denied, please try again",
        "host key verification failed",
        "no supported authentication methods",
    ]) {
        YagguiError::auth_failed(true)
    } else if any(&[
        "authentication failed",
        "could not read username",
        "could not read password",
        "terminal prompts disabled",
        "invalid username or password",
        "http basic: access denied",
        "the requested url returned error: 401",
        "the requested url returned error: 403",
    ]) {
        YagguiError::auth_failed(false)
    } else if any(&[
        "does not appear to be a git repository",
        "repository not found",
        "no such remote",
        "the requested url returned error: 404",
    ]) || (lower.contains("repository '") && lower.contains("not found"))
    {
        YagguiError::remote_not_found()
    } else if any(&[
        "could not resolve host",
        "could not resolve hostname",
        "connection refused",
        "connection timed out",
        "operation timed out",
        "network is unreachable",
        "no route to host",
        "failed to connect to",
        "connection reset by peer",
        "name or service not known",
        "unable to connect to",
    ]) {
        YagguiError::host_unreachable()
    } else if any(&["has no upstream branch", "no tracking information"]) {
        // The branch name is in the message, but the UI knows which branch it pushed.
        YagguiError::no_upstream("HEAD")
    } else if lower.contains("not possible to fast-forward") {
        YagguiError::not_fast_forward()
    } else {
        return None;
    })
}

/// `fatal: 'feat' is already used by worktree at '/path'` (Git ≥ 2.42) or
/// `fatal: 'feat' is already checked out at '/path'` → (`feat`, `/path`).
fn extract_other_worktree(stderr: &str) -> Option<(String, String)> {
    let line = stderr.lines().find(|line| {
        line.contains("is already used by worktree at")
            || line.contains("is already checked out at")
    })?;
    let mut quoted = line.split('\'').skip(1).step_by(2);
    Some((quoted.next()?.to_owned(), quoted.next()?.to_owned()))
}

/// The text of the first line containing both, between `start` and `end`.
fn extract_between(stderr: &str, start: &str, end: &str) -> Option<String> {
    stderr.lines().find_map(|line| {
        let from = line.find(start)? + start.len();
        let to = line[from..].find(end)? + from;
        Some(line[from..to].to_owned())
    })
}

/// `fatal: detected dubious ownership in repository at '/some/path'`
fn extract_dubious_path(stderr: &str) -> Option<String> {
    let line = stderr
        .lines()
        .find(|line| line.contains("dubious ownership"))?;
    let start = line.find('\'')? + 1;
    let end = line[start..].find('\'')? + start;
    Some(line[start..end].to_owned())
}

/// `error: patch failed: src/a.rs:12` → `src/a.rs`.
fn extract_after(stderr: &str, needle: &str) -> Option<String> {
    let line = stderr.lines().find(|line| line.contains(needle))?;
    let rest = &line[line.find(needle)? + needle.len()..];
    let file = rest.rsplit_once(':').map_or(rest, |(file, _)| file);
    Some(file.trim().to_owned())
}

/// Returns the first single-quoted string containing `needle`.
fn extract_quoted(stderr: &str, needle: &str) -> Option<String> {
    stderr
        .split('\'')
        .skip(1)
        .step_by(2)
        .find(|part| part.contains(needle))
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_signing_failures() {
        let case = |stderr: &str| classify_git_failure(stderr, "", None, None);
        let ssh = case(
            "error: Enter passphrase: Load key \"/k\": incorrect passphrase supplied to decrypt private key?\n\nfatal: failed to write commit object\n",
        );
        assert_eq!(ssh.code, ErrorCode::SigningFailed);
        assert!(ssh.message.en.contains("passphrase"));
        let gpg = case(
            "error: gpg failed to sign the data:\ngpg: signing failed: Inappropriate ioctl for device\n\nfatal: failed to write commit object\n",
        );
        assert_eq!(gpg.code, ErrorCode::SigningFailed);
        assert!(gpg.message.fr.contains("phrase de passe"));
        let no_key = case(
            "error: gpg failed to sign the data:\ngpg: skipped \"AB\": No secret key\ngpg: signing failed: No secret key\n\nfatal: failed to write commit object\n",
        );
        assert_eq!(no_key.code, ErrorCode::SigningFailed);
        assert!(no_key.message.en.contains("user.signingkey"));
        assert_eq!(
            case("error: Couldn't load public key /k.pub: No such file or directory?\n\nfatal: failed to write commit object\n").code,
            ErrorCode::SigningFailed
        );
    }

    #[test]
    fn classifies_network_failures() {
        let case = |stderr: &str| classify_git_failure(stderr, "", None, None);
        let rejected = case(
            " ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'x'\nhint: Updates were rejected because the remote contains work that you do\n",
        );
        assert_eq!(rejected.code, ErrorCode::PushRejected);
        assert_eq!(rejected.action, Some(ErrorAction::PullThenPush));
        assert_eq!(
            case(" ! [rejected]        main -> main (stale info)\n").code,
            ErrorCode::StaleLease
        );
        let ssh = case(
            "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n",
        );
        assert_eq!(ssh.code, ErrorCode::AuthFailed);
        assert!(ssh.message.fr.contains("ssh-agent"));
        let https = case(
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
        );
        assert!(https.message.fr.contains("credential helper"));
        assert_eq!(
            case("fatal: 'nope' does not appear to be a git repository\nfatal: Could not read from remote repository.\n").code,
            ErrorCode::RemoteNotFound
        );
        assert_eq!(
            case("fatal: unable to access 'https://nope.invalid/x.git/': Could not resolve host: nope.invalid\n").code,
            ErrorCode::HostUnreachable
        );
        assert_eq!(
            case("fatal: The current branch feat has no upstream branch.\n").code,
            ErrorCode::NoUpstream
        );
        assert_eq!(
            case("fatal: Not possible to fast-forward, aborting.\n").code,
            ErrorCode::NotFastForward
        );
    }

    #[test]
    fn classifies_dubious_ownership() {
        let stderr = "fatal: detected dubious ownership in repository at '/srv/repo'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory /srv/repo\n";
        let error = classify_git_failure(stderr, "", Some("/srv/repo/sub"), None);
        assert_eq!(error.code, ErrorCode::UnsafeRepository);
        assert_eq!(
            error.action,
            Some(ErrorAction::AddSafeDirectory {
                path: "/srv/repo".into()
            })
        );
    }

    #[test]
    fn classifies_long_paths_on_windows() {
        for stderr in [
            "error: unable to create file a/very/long/path.txt: Filename too long\n",
            "fatal: cannot create directory at 'a/very/long': Filename too long\n",
            "error: open(\"a/very/long/path.txt\"): Filename too long\nfatal: Unable to process path a/very/long/path.txt\n",
        ] {
            let err = classify_git_failure(stderr, "", Some("C:\\repo"), Some(1));
            assert_eq!(err.code, ErrorCode::PathTooLong, "{stderr}");
            assert!(err.message.en.contains("core.longpaths"));
        }
    }

    #[test]
    fn classifies_index_lock() {
        let stderr = "fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository";
        let error = classify_git_failure(stderr, "", Some("/r"), Some(3));
        assert_eq!(error.code, ErrorCode::IndexLocked);
        assert_eq!(
            error.action,
            Some(ErrorAction::RemoveIndexLock {
                repo_id: Some(3),
                path: "/r/.git/index.lock".into()
            })
        );
    }

    #[test]
    fn classifies_remote_management_failures() {
        let exists =
            classify_git_failure("error: remote upstream already exists.\n", "", None, None);
        assert_eq!(exists.code, ErrorCode::RemoteExists);
        assert!(exists.message.fr.contains("« upstream »"));
        let invalid =
            classify_git_failure("fatal: 'a b' is not a valid remote name\n", "", None, None);
        assert_eq!(invalid.code, ErrorCode::InvalidRemoteName);
        assert!(invalid.message.en.contains("\"a b\""));
        assert_eq!(
            classify_git_failure("error: No such remote: 'nope'\n", "", None, None).code,
            ErrorCode::RemoteNotFound
        );
    }

    #[test]
    fn classifies_not_a_repository() {
        let stderr = "fatal: not a git repository (or any of the parent directories): .git";
        let error = classify_git_failure(stderr, "", Some("/tmp"), None);
        assert_eq!(error.code, ErrorCode::NotARepository);
        assert!(error.detail.is_some());
    }

    #[test]
    fn backend_errors_keep_their_cause_chain() {
        let io = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "access denied");
        let err: YagguiError = BackendError::io("cannot remove /r/.git/index.lock", io).into();
        assert_eq!(err.code, ErrorCode::Internal);
        assert_eq!(
            err.detail.as_deref(),
            Some("cannot remove /r/.git/index.lock: access denied")
        );

        let sqlite = rusqlite::Error::InvalidQuery;
        let err: YagguiError = sqlite.into();
        assert_eq!(err.code, ErrorCode::Storage);
        assert!(err.detail.unwrap().starts_with("database error: "));
    }

    #[test]
    fn classifies_clone_failures() {
        let code = |stderr: &str| classify_git_failure(stderr, "", None, None).code;
        for auth in [
            "fatal: Authentication failed for 'https://example.com/a/b.git/'",
            "fatal: could not read Username for 'https://example.com': terminal prompts disabled",
            "git@example.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
            "Host key verification failed.\nfatal: Could not read from remote repository.",
            "fatal: unable to access 'https://x/': The requested URL returned error: 403",
        ] {
            assert_eq!(code(auth), ErrorCode::AuthFailed, "{auth}");
        }
        for down in [
            "fatal: unable to access 'https://nope.invalid/r.git/': Could not resolve host: nope.invalid",
            "ssh: connect to host example.com port 22: Connection refused\nfatal: Could not read from remote repository.",
            "fatal: unable to connect to example.com:\nexample.com[0: 1.2.3.4]: errno=Connection timed out",
            "ssh: Could not resolve hostname nope: Name or service not known",
        ] {
            assert_eq!(code(down), ErrorCode::HostUnreachable, "{down}");
        }
        for missing in [
            "remote: Repository not found.\nfatal: repository 'https://x/y.git/' not found",
            "fatal: '/srv/none' does not appear to be a git repository\nfatal: Could not read from remote repository.",
            "fatal: unable to access 'https://x/y.git/': The requested URL returned error: 404",
        ] {
            assert_eq!(code(missing), ErrorCode::RemoteNotFound, "{missing}");
        }
        let branch = classify_git_failure(
            "warning: Could not find remote branch nope to clone.\nfatal: Remote branch nope not found in upstream origin",
            "",
            None,
            None,
        );
        assert_eq!(branch.code, ErrorCode::RemoteBranchNotFound);
        assert!(branch.message.en.contains("\"nope\""));
        let target = classify_git_failure(
            "fatal: destination path '/tmp/x' already exists and is not an empty directory.",
            "",
            None,
            None,
        );
        assert_eq!(target.code, ErrorCode::TargetNotEmpty);
        assert!(target.message.en.contains("/tmp/x"));
    }

    #[test]
    fn auth_errors_say_that_yaggui_stores_no_secret() {
        assert!(
            YagguiError::auth_failed(false)
                .message
                .en
                .contains("credential helper")
        );
        assert!(
            YagguiError::auth_failed(true)
                .message
                .fr
                .contains("ssh-agent")
        );
    }

    #[test]
    fn classifies_write_failures() {
        let code =
            |stderr: &str, stdout: &str| classify_git_failure(stderr, stdout, None, Some(1)).code;
        assert_eq!(
            code(
                "",
                "On branch main\nnothing to commit, working tree clean\n"
            ),
            ErrorCode::NothingToCommit
        );
        assert_eq!(
            code(
                "",
                "Changes not staged for commit:\n\tmodified: a\n\nno changes added to commit (use \"git add\")\n"
            ),
            ErrorCode::NothingToCommit
        );
        assert_eq!(
            code(
                "Author identity unknown\n\n*** Please tell me who you are.\n",
                ""
            ),
            ErrorCode::IdentityUnknown
        );
        assert_eq!(
            code(
                "fatal: no email was given and auto-detection is disabled\n",
                ""
            ),
            ErrorCode::IdentityUnknown
        );
        assert_eq!(
            code("fatal: empty ident name (for <a@b>) not allowed\n", ""),
            ErrorCode::IdentityUnknown
        );
        assert_eq!(
            code(
                "error: Committing is not possible because you have unmerged files.\n",
                ""
            ),
            ErrorCode::UnresolvedConflicts
        );
        assert_eq!(
            code("error: path 'a.txt' is unmerged\n", ""),
            ErrorCode::UnresolvedConflicts
        );
        let stale = classify_git_failure(
            "error: patch failed: src/a b.rs:12\nerror: src/a b.rs: patch does not apply\n",
            "",
            None,
            None,
        );
        assert_eq!(stale.code, ErrorCode::StaleDiff);
        assert!(
            stale.message.en.starts_with("src/a b.rs changed"),
            "{}",
            stale.message.en
        );
        assert_eq!(
            code("fatal: You are not currently on a branch.\n", ""),
            ErrorCode::DetachedHead
        );
    }

    #[test]
    fn classifies_worktree_and_lfs_failures() {
        let case = |stderr: &str| classify_git_failure(stderr, "", Some("/r/wt"), None);
        let other = case("fatal: 'feat' is already used by worktree at '/r/wt'\n");
        assert_eq!(other.code, ErrorCode::BranchInOtherWorktree);
        assert!(
            other.message.en.contains("\"feat\""),
            "{}",
            other.message.en
        );
        assert!(other.message.fr.contains("/r/wt"));
        assert_eq!(
            case("fatal: 'feat' is already checked out at '/r/wt'\n").code,
            ErrorCode::BranchInOtherWorktree
        );
        let dirty =
            case("fatal: '/r/wt' contains modified or untracked files, use --force to delete it\n");
        assert_eq!(dirty.code, ErrorCode::WorktreeDirty);
        assert!(dirty.message.en.contains("/r/wt"));
        assert_eq!(
            case("fatal: cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first\n").code,
            ErrorCode::WorktreeLocked
        );
        assert_eq!(
            case("git: 'lfs' is not a git command. See 'git --help'.\n").code,
            ErrorCode::LfsNotInstalled
        );
    }

    #[test]
    fn falls_back_to_generic_failure() {
        let error = classify_git_failure("error: something odd", "", None, None);
        assert_eq!(error.code, ErrorCode::GitFailed);
        assert_eq!(error.detail.as_deref(), Some("error: something odd"));
    }
}
