//! Git configuration editor (F-325) and checks of the external tools (F-323).
//!
//! Reads and writes are `git config` runs through `git/cli.rs`: Git resolves includes and
//! scopes, and writes the file itself. Writes go through the `OpQueue` of the repository (local
//! scope) or through the queue of the global configuration, so they never overlap another
//! write.

use std::sync::Arc;
use std::sync::atomic::AtomicU64;

use crate::events::OpKind;
use crate::git::cli::{GitCli, GitCommand};
use crate::git::errors::{BackendError, YagguiError};
use crate::git::ops::config::{
    ConfigEntry, ExternalToolCheck, ExternalToolKind, ToolIssue, parse_config_list,
    parse_tool_help, validate_key, validate_value,
};
use crate::git::ops::types::ConfigScope;
use crate::store::is_tool_name;
use crate::system::{editor, terminal};

use super::RepoManager;
use super::lock;
use super::op_queue::OpQueue;

fn scope_flag(scope: ConfigScope) -> &'static str {
    match scope {
        ConfigScope::Repo => "--local",
        ConfigScope::Global => "--global",
    }
}

fn local_needs_repo() -> YagguiError {
    YagguiError::invalid_argument(
        "The repository configuration needs an open repository.",
        "La configuration du dépôt demande un dépôt ouvert.",
    )
}

impl RepoManager {
    fn global_queue(&self) -> Result<Arc<OpQueue>, YagguiError> {
        let mut slot = lock(&self.global_queue);
        if let Some(queue) = slot.as_ref() {
            return Ok(Arc::clone(queue));
        }
        let queue = Arc::new(OpQueue::new(
            0,
            Arc::clone(&self.sink),
            Arc::new(AtomicU64::new(0)),
        )?);
        *slot = Some(Arc::clone(&queue));
        Ok(queue)
    }

    /// Entries of one config file (`--local` or `--global`), in file order.
    pub fn git_config_list(
        &self,
        repo_id: Option<u32>,
        scope: ConfigScope,
    ) -> Result<Vec<ConfigEntry>, YagguiError> {
        let mut command = GitCommand::new(["config", scope_flag(scope), "--list", "-z"]);
        match (scope, repo_id) {
            (ConfigScope::Repo, None) => return Err(local_needs_repo()),
            (ConfigScope::Repo, Some(id)) => {
                command = command.cwd(&self.session(id)?.workdir).repo(id);
            }
            (ConfigScope::Global, Some(id)) => command = command.repo(id),
            (ConfigScope::Global, None) => {}
        }
        let run = self.git.run_raw(&command, None, None)?;
        if run.success {
            return Ok(parse_config_list(&run.stdout));
        }
        // No ~/.gitconfig yet: an empty configuration, not an error.
        if run.stderr.contains("No such file") || run.stderr.contains("cannot be read") {
            return Ok(Vec::new());
        }
        Err(YagguiError::git_failed(&run.stderr))
    }

    /// Sets `key` in the file of `scope`, or removes every value of it when `value` is `None`.
    /// A key set several times (`remote.origin.fetch`) is replaced as a whole.
    pub fn git_config_set(
        &self,
        repo_id: Option<u32>,
        scope: ConfigScope,
        key: String,
        value: Option<String>,
    ) -> Result<(), YagguiError> {
        validate_key(&key)?;
        if let Some(value) = &value {
            validate_value(value)?;
        }
        let removing = value.is_none();
        let mut list = vec!["config".to_owned(), scope_flag(scope).to_owned()];
        list.push(
            if removing {
                "--unset-all"
            } else {
                "--replace-all"
            }
            .to_owned(),
        );
        list.push("--".to_owned());
        list.push(key);
        list.extend(value);
        let git: Arc<GitCli> = Arc::clone(&self.git);
        match (scope, repo_id) {
            (ConfigScope::Repo, None) => Err(local_needs_repo()),
            (ConfigScope::Repo, Some(id)) => self.write_op(id, OpKind::Config, false, move |ctx| {
                let run = ctx
                    .git
                    .run_raw(&ctx.command(list), Some(ctx.cancel), None)?;
                finish_set(&run, removing)
            }),
            (ConfigScope::Global, _) => {
                let repo = repo_id.unwrap_or(0);
                self.global_queue()?.run(OpKind::Config, false, move |op| {
                    let mut command = GitCommand::new(list);
                    if repo != 0 {
                        command = command.repo(repo);
                    }
                    let run = git.run_raw(&command, Some(op.cancel), None)?;
                    finish_set(&run, removing)
                })
            }
        }
    }

    /// What "open in editor" opens: the worktree, or a file of it (checked not to leave it).
    pub fn editor_target(
        &self,
        repo_id: u32,
        path: Option<String>,
    ) -> Result<std::path::PathBuf, YagguiError> {
        let workdir = self.session(repo_id)?.workdir.clone();
        let Some(path) = path else { return Ok(workdir) };
        let path = super::write::checked_paths(&workdir, vec![path])?.remove(0);
        Ok(workdir.join(path))
    }

    /// Whether an external tool of the preferences works (F-323). `name` is the value being
    /// edited, tested before it is saved; `None` tests the saved one. An editor and a terminal
    /// are really started (on a scratch file, in the temp folder); a diff or merge tool is
    /// looked up in what Git knows and finds installed (`--tool-help`).
    pub fn check_external_tool(
        &self,
        kind: ExternalToolKind,
        name: Option<String>,
        repo_id: Option<u32>,
    ) -> Result<ExternalToolCheck, YagguiError> {
        let prefs = self.store.preferences()?;
        let name = name.map(|n| n.trim().to_owned()).filter(|n| !n.is_empty());
        match kind {
            ExternalToolKind::Editor => {
                let name = name.or(prefs.editor);
                let scratch = std::env::temp_dir().join("yaggui-editor-test.txt");
                std::fs::write(&scratch, "yaggui opened this file to test the editor.\n")
                    .map_err(|e| BackendError::io("cannot write the test file", e))?;
                let tool = editor::open(&scratch, name.as_deref())?;
                Ok(ExternalToolCheck {
                    tool,
                    ok: true,
                    issue: None,
                })
            }
            ExternalToolKind::Terminal => {
                let name = name.or(prefs.terminal);
                let tool = terminal::open(&std::env::temp_dir(), name.as_deref())?;
                Ok(ExternalToolCheck {
                    tool,
                    ok: true,
                    issue: None,
                })
            }
            ExternalToolKind::DiffTool => {
                self.check_git_tool("diff", name.or(prefs.diff_tool), repo_id)
            }
            ExternalToolKind::MergeTool => {
                self.check_git_tool("merge", name.or(prefs.merge_tool), repo_id)
            }
        }
    }

    /// `family` is `diff` or `merge`: `git <family>tool --tool-help`, `<family>.tool`.
    fn check_git_tool(
        &self,
        family: &str,
        name: Option<String>,
        repo_id: Option<u32>,
    ) -> Result<ExternalToolCheck, YagguiError> {
        let cwd = match repo_id {
            Some(id) => Some(self.session(id)?.workdir.clone()),
            None => None,
        };
        let with_cwd = |command: GitCommand| match &cwd {
            Some(dir) => command.cwd(dir),
            None => command,
        };
        let configured = |key: String| -> Result<Option<String>, YagguiError> {
            let run = self.git.run_raw(
                &with_cwd(GitCommand::new(["config", "--get", &key])),
                None,
                None,
            )?;
            let value = run.stdout.trim().to_owned();
            Ok((run.success && !value.is_empty()).then_some(value))
        };
        // Same order as launching a diff (`diff_tool` in graph_tools.rs): the preference,
        // `diff.tool`, then `diff.guitool`.
        let name = match name {
            Some(name) => Some(name),
            None => match configured(format!("{family}.tool"))? {
                Some(name) => Some(name),
                None if family == "diff" => configured("diff.guitool".to_owned())?,
                None => None,
            },
        };
        let Some(name) = name else {
            return Ok(ExternalToolCheck {
                tool: String::new(),
                ok: false,
                issue: Some(ToolIssue::NotConfigured),
            });
        };
        if !is_tool_name(&name) {
            return Err(YagguiError::invalid_argument(
                format!("\"{name}\" is not a valid tool name."),
                format!("« {name} » n'est pas un nom d'outil valide."),
            ));
        }
        let help = self.git.run_raw(
            &with_cwd(GitCommand::new([&format!("{family}tool"), "--tool-help"])),
            None,
            None,
        )?;
        let known = parse_tool_help(&help.stdout);
        let custom = self.git.run_raw(
            &with_cwd(GitCommand::new([
                "config",
                "--get",
                &format!("{family}tool.{name}.cmd"),
            ])),
            None,
            None,
        )?;
        let issue = if known.available.contains(&name) || custom.success {
            None
        } else if known.missing.contains(&name) {
            Some(ToolIssue::NotInstalled)
        } else {
            Some(ToolIssue::Unknown)
        };
        Ok(ExternalToolCheck {
            tool: name,
            ok: issue.is_none(),
            issue,
        })
    }
}

/// `--unset-all` of a key that is not set exits with 5: that is the wanted state.
fn finish_set(run: &crate::git::cli::GitRun, removing: bool) -> Result<(), YagguiError> {
    if run.success || (removing && run.exit_code == Some(5)) {
        return Ok(());
    }
    Err(crate::git::errors::classify_git_failure(
        &run.stderr,
        "",
        None,
        None,
    ))
}
