//! Commit and stash V1 services of `RepoManager` (M4-7a): commit template and signing
//! settings, signature checks, "Add to .gitignore" and the stash of selected files.

use std::path::{Path, PathBuf};

use gix::bstr::BStr;

use crate::events::OpKind;
use crate::git::cli::GitCommand;
use crate::git::errors::{BackendError, YagguiError};
use crate::git::ops::gitignore::IgnoreRule;
use crate::git::ops::types::{
    CommitSettings, GITIGNORE_PREVIEW_MAX, GitignorePreview, GitignoreRuleKind, JOURNAL_PATHS_MAX,
    JournalOp, SignatureCheck, SignatureStatus, SigningFormat, StashEntryInfo, StashPathsRequest,
};
use crate::git::read::refs::read_stashes;

use super::RepoManager;
use super::journal::{Mode, Plan};
use super::ref_ops::find_ref;
use super::write::{Backup, WriteContext, checked_paths, split_message};

/// Largest `commit.template` read; a bigger file is not a message template.
const TEMPLATE_MAX: u64 = 64 * 1024;
const GITIGNORE: &str = ".gitignore";

impl RepoManager {
    /// `git config --get` (resolving includes and every scope, like the commit itself).
    fn config_value(&self, repo_id: u32, args: &[&str]) -> Result<Option<String>, YagguiError> {
        let session = self.session(repo_id)?;
        let mut command = GitCommand::new(["config"])
            .cwd(&session.workdir)
            .repo(repo_id);
        for arg in args {
            command = command.arg(arg);
        }
        let run = self.git.run_raw(&command, None, None)?;
        let value = run.stdout.trim_end_matches(['\n', '\r']);
        Ok((run.success && !value.trim().is_empty()).then(|| value.to_owned()))
    }

    /// Template message (`commit.template`) and signing configuration, for the commit panel.
    pub fn commit_settings(&self, repo_id: u32) -> Result<CommitSettings, YagguiError> {
        let workdir = self.session(repo_id)?.workdir.clone();
        let sign = self
            .config_value(repo_id, &["--type=bool", "--get", "commit.gpgsign"])?
            .is_some_and(|v| v == "true")
            .then(|| -> Result<SigningFormat, YagguiError> {
                Ok(
                    match self
                        .config_value(repo_id, &["--get", "gpg.format"])?
                        .as_deref()
                    {
                        Some("ssh") => SigningFormat::Ssh,
                        Some("x509") => SigningFormat::X509,
                        _ => SigningFormat::Openpgp,
                    },
                )
            })
            .transpose()?;
        let signing_key = self.config_value(repo_id, &["--get", "user.signingkey"])?;
        let template_path =
            self.config_value(repo_id, &["--type=path", "--get", "commit.template"])?;
        let (template, template_error) = match &template_path {
            None => (None, None),
            Some(path) => match read_template(&workdir, path) {
                Ok(text) => {
                    let message = split_message(&strip_comments(&text));
                    (
                        (!message.summary.is_empty() || !message.description.is_empty())
                            .then_some(message),
                        None,
                    )
                }
                Err(err) => (None, Some(err)),
            },
        };
        Ok(CommitSettings {
            template,
            template_path,
            template_error,
            sign,
            signing_key,
        })
    }

    /// Verifies the signature of `sha` with Git (`%G?`), which runs gpg, gpgsm or ssh-keygen
    /// as configured.
    pub fn verify_signature(&self, repo_id: u32, sha: &str) -> Result<SignatureCheck, YagguiError> {
        let session = self.session(repo_id)?;
        if sha.len() < 4 || sha.len() > 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(YagguiError::invalid_argument(
                format!("\"{sha}\" is not a commit id."),
                format!("« {sha} » n'est pas un identifiant de commit."),
            ));
        }
        let signed = {
            let repo = session.repo()?.to_thread_local();
            let id = repo
                .rev_parse_single(BStr::new(sha.as_bytes()))
                .map_err(|_| YagguiError::revision_not_found(sha))?;
            let commit = repo
                .find_commit(id)
                .map_err(|_| YagguiError::revision_not_found(sha))?;
            let decoded = commit
                .decode()
                .map_err(|e| BackendError::gix("decode a commit", e))?;
            decoded.extra_headers().pgp_signature().is_some()
        };
        if !signed {
            return Ok(SignatureCheck {
                status: SignatureStatus::Unsigned,
                signer: None,
                key: None,
                reason: None,
            });
        }
        let run = self.git.run_raw(
            &GitCommand::new([
                "-c",
                "log.showSignature=false",
                "show",
                "-s",
                "--format=%G?%x00%GS%x00%GK",
                sha,
                "--",
            ])
            .cwd(&session.workdir)
            .repo(repo_id),
            None,
            None,
        )?;
        if !run.success {
            return Err(YagguiError::git_failed(&run.stderr));
        }
        Ok(parse_signature_check(&run.stdout, &run.stderr))
    }

    /// The rule "Add to .gitignore" would write for `path`, and the untracked files it hides.
    pub fn gitignore_preview(
        &self,
        repo_id: u32,
        path: &str,
        kind: GitignoreRuleKind,
    ) -> Result<GitignorePreview, YagguiError> {
        let session = self.session(repo_id)?;
        let workdir = session.workdir.clone();
        let path = checked_paths(&workdir, vec![path.to_owned()])?.remove(0);
        let rule = IgnoreRule::for_path(&path, kind)?;
        let current = read_gitignore(&workdir)?;
        let run = self.git.run(
            &GitCommand::new(["ls-files", "-z", "--others", "--exclude-standard"])
                .cwd(&workdir)
                .repo(repo_id),
        )?;
        let mut matches = Vec::new();
        let mut match_count = 0_u32;
        for file in run.stdout.split('\0').filter(|f| rule.matches(f)) {
            match_count += 1;
            if matches.len() < GITIGNORE_PREVIEW_MAX as usize {
                matches.push(file.to_owned());
            }
        }
        Ok(GitignorePreview {
            exists: rule.is_in(&current),
            rule: rule.line,
            matches,
            match_count,
        })
    }

    /// Appends the rule of `kind` for `path` to the root `.gitignore` (created if missing).
    /// Journaled like a discard: the undo puts the previous file back.
    pub fn add_to_gitignore(
        &self,
        repo_id: u32,
        path: String,
        kind: GitignoreRuleKind,
    ) -> Result<String, YagguiError> {
        let backups = self.backup_dir();
        self.journal_op(repo_id, OpKind::Maintenance, false, false, move |ctx| {
            let path = checked_paths(ctx.workdir, vec![path])?.remove(0);
            let rule = IgnoreRule::for_path(&path, kind)?;
            let current = read_gitignore(ctx.workdir)?;
            if rule.is_in(&current) {
                return Ok((rule.line, None));
            }
            let mut backup = Backup::create(&backups?, ctx, "gitignore")?;
            backup.save(ctx, GITIGNORE, false)?;
            let (_, saved) = backup.finish()?;
            let file = ctx.workdir.join(GITIGNORE);
            std::fs::write(&file, rule.append_to(&current)).map_err(|e| {
                YagguiError::from(BackendError::io(
                    format!("cannot write {}", file.display()),
                    e,
                ))
            })?;
            let op = JournalOp::Gitignore {
                rule: rule.line.clone(),
            };
            Ok((
                rule.line,
                Some(Plan::new(op, Mode::Files).with_files(saved)),
            ))
        })
    }

    /// `git stash push -- <paths>`: stashes the staged and unstaged changes of these files only
    /// (and, with `include_untracked`, the selected untracked ones). Journaled: the undo puts
    /// the files back as they were and drops the stash.
    pub fn stash_push_paths(
        &self,
        repo_id: u32,
        request: StashPathsRequest,
    ) -> Result<StashEntryInfo, YagguiError> {
        let backups = self.backup_dir();
        self.journal_op(repo_id, OpKind::Stash, false, false, move |ctx| {
            let entry_paths = stashable_paths(ctx, request.paths, request.include_untracked)?;
            let mut backup = Backup::create(&backups?, ctx, "stashPush")?;
            for path in &entry_paths {
                backup.save(ctx, path, true)?;
            }
            let (_, saved) = backup.finish()?;

            let mut args = vec!["stash", "push", "-q"];
            if request.include_untracked {
                args.push("--include-untracked");
            }
            let message = request
                .message
                .as_deref()
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .map(|m| format!("--message={m}"));
            if let Some(message) = &message {
                args.push(message.as_str());
            }
            let before = find_ref(ctx.repo, "refs/stash")?;
            ctx.run_on_paths(&args, &entry_paths)?;
            let after = find_ref(ctx.repo, "refs/stash")?;
            let (Some(sha), true) = (after, after != before) else {
                return Err(YagguiError::nothing_to_stash());
            };
            let entry = read_stashes(ctx.repo)?
                .into_iter()
                .next()
                .filter(|e| e.id == sha)
                .ok_or_else(YagguiError::nothing_to_stash)?;
            let op = JournalOp::StashPush {
                message: entry.message.clone(),
                paths: entry_paths
                    .iter()
                    .take(JOURNAL_PATHS_MAX as usize)
                    .cloned()
                    .collect(),
                count: u32::try_from(entry_paths.len()).unwrap_or(u32::MAX),
            };
            let mode = Mode::StashPush {
                sha,
                message: entry.message.clone(),
            };
            let info = StashEntryInfo {
                sha: sha.to_string(),
                message: entry.message,
            };
            Ok((info, Some(Plan::new(op, mode).with_files(saved))))
        })
    }
}

/// The selected files `git stash push` accepts: without `include_untracked`, untracked files
/// are left out (Git refuses a pathspec it does not know). Folders are refused, like a discard.
fn stashable_paths(
    ctx: &WriteContext<'_>,
    paths: Vec<String>,
    include_untracked: bool,
) -> Result<Vec<String>, YagguiError> {
    let mut paths = checked_paths(ctx.workdir, paths)?;
    paths.sort();
    paths.dedup();
    if let Some(dir) = paths
        .iter()
        .find(|p| std::fs::symlink_metadata(ctx.workdir.join(p)).is_ok_and(|m| m.is_dir()))
    {
        return Err(YagguiError::invalid_argument(
            format!("\"{dir}\" is a folder: select its files instead."),
            format!("« {dir} » est un dossier : sélectionne plutôt ses fichiers."),
        ));
    }
    if !include_untracked {
        let index = ctx.index()?;
        let tree = if ctx.is_unborn()? {
            None
        } else {
            Some(
                ctx.repo
                    .head_commit()
                    .and_then(|c| c.tree())
                    .map_err(|e| BackendError::gix("read HEAD tree", e))?,
            )
        };
        let mut known = Vec::new();
        for path in paths {
            let in_index = index.entry_by_path(BStr::new(path.as_bytes())).is_some()
                || index
                    .entry_range(BStr::new(path.as_bytes()))
                    .is_some_and(|r| !r.is_empty());
            let in_head = match &tree {
                Some(tree) => tree
                    .lookup_entry_by_path(&path)
                    .map_err(|e| BackendError::gix("read HEAD tree", e))?
                    .is_some(),
                None => false,
            };
            if in_index || in_head {
                known.push(path);
            }
        }
        paths = known;
    }
    if paths.is_empty() {
        return Err(YagguiError::nothing_to_stash());
    }
    Ok(paths)
}

fn read_gitignore(workdir: &Path) -> Result<String, YagguiError> {
    let file = workdir.join(GITIGNORE);
    match std::fs::symlink_metadata(&file) {
        Ok(meta) if !meta.is_file() => Err(YagguiError::invalid_argument(
            ".gitignore is not a regular file (a link or a folder): edit it by hand.",
            ".gitignore n'est pas un fichier ordinaire (un lien ou un dossier) : modifie-le à la main.",
        )),
        Ok(_) => std::fs::read(&file)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .map_err(|e| BackendError::io(format!("cannot read {}", file.display()), e).into()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(BackendError::io(format!("cannot read {}", file.display()), err).into()),
    }
}

/// Reads the template file; a relative path is relative to the working tree, where
/// `git commit` runs.
fn read_template(workdir: &Path, path: &str) -> Result<String, String> {
    let full = {
        let p = PathBuf::from(path);
        if p.is_absolute() { p } else { workdir.join(p) }
    };
    let meta = std::fs::metadata(&full).map_err(|e| format!("{}: {e}", full.display()))?;
    if !meta.is_file() || meta.len() > TEMPLATE_MAX {
        return Err(format!(
            "{}: not a file of at most {TEMPLATE_MAX} bytes",
            full.display()
        ));
    }
    std::fs::read(&full)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .map_err(|e| format!("{}: {e}", full.display()))
}

/// Git drops `#` lines from a template only when an editor is used; yaggui commits with `-F`.
fn strip_comments(text: &str) -> String {
    text.lines()
        .filter(|line| !line.starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `%G?\0%GS\0%GK` and the verifier's stderr.
fn parse_signature_check(stdout: &str, stderr: &str) -> SignatureCheck {
    let mut parts = stdout.trim_end_matches(['\n', '\r']).split('\0');
    let code = parts.next().unwrap_or_default();
    let field = |v: Option<&str>| {
        v.map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    let signer = field(parts.next());
    let key = field(parts.next());
    let status = match code {
        "G" => SignatureStatus::Verified,
        "B" => SignatureStatus::Bad,
        "X" | "Y" => SignatureStatus::Expired,
        "R" => SignatureStatus::Revoked,
        // U: valid, unknown trust; E: cannot be checked (missing key); N with a signature:
        // nothing to check it with (no `gpg.ssh.allowedSignersFile`, no gpg).
        _ => SignatureStatus::Unverified,
    };
    let reason = (status != SignatureStatus::Verified)
        .then(|| {
            stderr
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .map(|l| l.strip_prefix("error: ").unwrap_or(l).to_owned())
        })
        .flatten();
    SignatureCheck {
        status,
        signer,
        key,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_signature_checks() {
        let good = parse_signature_check("G\0Ada <a@x>\0ABCD\n", "");
        assert_eq!(good.status, SignatureStatus::Verified);
        assert_eq!(good.signer.as_deref(), Some("Ada <a@x>"));
        assert_eq!(good.reason, None);
        let none = parse_signature_check(
            "N\0\0\n",
            "error: gpg.ssh.allowedSignersFile needs to be configured and exist for ssh signature verification\n",
        );
        assert_eq!(none.status, SignatureStatus::Unverified);
        assert!(
            none.reason
                .unwrap()
                .starts_with("gpg.ssh.allowedSignersFile")
        );
        assert_eq!(
            parse_signature_check("B\0\0", "").status,
            SignatureStatus::Bad
        );
        assert_eq!(
            parse_signature_check("Y\0\0", "").status,
            SignatureStatus::Expired
        );
    }

    #[test]
    fn strips_template_comments() {
        let text = strip_comments("feat: \n# Type: feat, fix\n\nWhy:\n#end\n");
        assert_eq!(split_message(&text).summary, "feat:");
        assert_eq!(split_message(&text).description, "Why:");
    }
}
