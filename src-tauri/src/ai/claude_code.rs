//! Claude Code provider (F-073): the user's `claude` CLI and login, run in print mode in the
//! repository (its `CLAUDE.md` and project skills apply), with read-only tools only.
//!
//! `claude` is not `git`: it does not go through `GitCli` / `OpQueue` (rule 1 covers Git
//! commands), but it gets the same treatment: separate arguments, no shell, no terminal, the
//! login shell's `PATH`, its process tree killed on cancellation, an entry in the command log.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::provider::{CallLog, CommitMessageProvider, GenerationRequest, ProviderReply};
use super::types::AiProviderKind;
use crate::git::cli::{CancelToken, INHERITED_GIT_ENV};
use crate::git::errors::YagguiError;
use crate::system::process::{self, ProcessTree};
use crate::system::shell_env;

const PROGRAM: &str = "claude";
/// What the model may use: reading the repository, and a skill when one is chosen. Nothing
/// that writes or runs a command: a skill written to commit cannot, and neither can a diff
/// that carries instructions.
const READ_TOOLS: &str = "Read,Grep,Glob";
/// Denied even if the user's settings allow them (deny rules win over allow rules).
const DENIED_TOOLS: &str = "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch";
const STDOUT_MAX: usize = 8 * 1024 * 1024;
const STDERR_MAX: usize = 256 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(50);
/// Output still open after exit belongs to processes the CLI left: not awaited longer.
const PIPES_GRACE: Duration = Duration::from_secs(2);
const VERSION_TIMEOUT: Duration = Duration::from_secs(15);

pub const SUGGESTED_MODELS: [&str; 3] = ["haiku", "sonnet", "opus"];

/// Tells the model where it runs; placed between the instructions and the context.
const READ_ONLY_NOTE: &str = "You are run by yaggui, a Git client, in read-only mode, in the \
repository the changes belong to. You may read its files (Read, Grep, Glob) when the diff \
alone does not explain a change. Do not modify any file, do not run commands, never stage, \
commit or push: yaggui shows the message to the user, who commits.";

/// The `claude` program to run: the configured one, or the first found on the login shell's
/// `PATH`, then in the usual install folders.
pub fn find(configured: Option<&str>) -> Option<PathBuf> {
    if let Some(configured) = configured {
        let path = Path::new(configured);
        if path.components().count() > 1 || path.is_absolute() {
            return path.is_file().then(|| path.to_path_buf());
        }
        return if cfg!(windows) && path.extension().is_none() {
            search_path(&[&format!("{configured}.exe"), &format!("{configured}.cmd")])
        } else {
            search_path(&[configured])
        };
    }
    let names: &[&str] = if cfg!(windows) {
        &["claude.exe", "claude.cmd"]
    } else {
        &[PROGRAM]
    };
    search_path(names).or_else(|| {
        well_known_dirs()
            .into_iter()
            .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
            .find(|candidate| candidate.is_file())
    })
}

fn search_path(names: &[&str]) -> Option<PathBuf> {
    let path = shell_env::child_path().or_else(|| std::env::var_os("PATH"))?;
    std::env::split_paths(&path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| candidate.is_file())
}

/// Where the installers put `claude` when the app's `PATH` misses it.
fn well_known_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = std::env::home_dir() {
        for sub in [
            ".claude/local",
            ".local/bin",
            ".npm-global/bin",
            ".bun/bin",
            ".volta/bin",
        ] {
            dirs.push(home.join(sub));
        }
    }
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
    } else {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    dirs
}

/// What `claude --version` prints (`2.1.311 (Claude Code)`); `None` when it does not run.
pub fn version(binary: &Path) -> Option<String> {
    let run = run(
        binary,
        &["--version".to_owned()],
        None,
        None,
        VERSION_TIMEOUT,
        &CancelToken::new(),
    )
    .ok()?;
    if !run.status.is_some_and(|s| s.success()) {
        return None;
    }
    let text = String::from_utf8_lossy(&run.stdout);
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.chars().take(100).collect())
}

pub struct ClaudeCode {
    binary: PathBuf,
}

impl ClaudeCode {
    pub fn new(binary: PathBuf) -> Self {
        Self { binary }
    }

    /// The arguments of a generation: print mode, JSON result, nothing saved, no MCP server,
    /// no permission prompt (anything not allowed is denied), read-only tools.
    pub fn args(model: Option<&str>, skill: bool) -> Vec<String> {
        let tools = if skill {
            format!("{READ_TOOLS},Skill")
        } else {
            READ_TOOLS.to_owned()
        };
        let mut args: Vec<String> = [
            "-p",
            "--output-format",
            "json",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--permission-mode",
            "dontAsk",
            "--tools",
            &tools,
            "--allowedTools",
            &tools,
            "--disallowedTools",
            DENIED_TOOLS,
        ]
        .iter()
        .map(|a| (*a).to_owned())
        .collect();
        if let Some(model) = model {
            args.push("--model".to_owned());
            args.push(model.to_owned());
        }
        args
    }

    /// The text written on stdin: instructions, the read-only note (and the skill to use),
    /// then the context.
    pub fn input(request: &GenerationRequest) -> String {
        let mut text = request.prompt.system.trim_end().to_owned();
        text.push_str("\n\n");
        text.push_str(READ_ONLY_NOTE);
        if let Some(skill) = &request.skill {
            text.push_str(&format!(
                " Write the message with the \"{skill}\" skill (Skill tool) and follow its \
                 conventions, but skip any of its steps that stages, commits, pushes or runs a \
                 command, and answer with the message only."
            ));
        }
        text.push_str("\n\n");
        text.push_str(&request.prompt.user);
        text
    }
}

impl CommitMessageProvider for ClaudeCode {
    fn kind(&self) -> AiProviderKind {
        AiProviderKind::ClaudeCode
    }

    fn generate(
        &self,
        request: &GenerationRequest,
        cancel: &CancelToken,
    ) -> (Result<ProviderReply, YagguiError>, CallLog) {
        let args = Self::args(request.model.as_deref(), request.skill.is_some());
        let mut log = CallLog {
            program: PROGRAM.to_owned(),
            args: args.clone(),
            exit_code: None,
            stderr: String::new(),
        };
        // The provider test has no repository: a neutral folder, so no project's CLAUDE.md
        // or settings apply.
        let cwd = request.workdir.clone().unwrap_or_else(std::env::temp_dir);
        let input = Self::input(request);
        let outcome = run(
            &self.binary,
            &args,
            Some(&cwd),
            Some(input.into_bytes()),
            request.timeout,
            cancel,
        );
        let result = match outcome {
            Err(RunError::Cancelled) => Err(YagguiError::cancelled()),
            Err(RunError::Timeout) => {
                log.stderr = "timed out".to_owned();
                Err(YagguiError::ai_timeout(request.timeout.as_secs() as u32))
            }
            Err(RunError::Spawn(err)) => {
                log.stderr = err.to_string();
                Err(if err.kind() == std::io::ErrorKind::NotFound {
                    not_found()
                } else {
                    YagguiError::ai_provider_unavailable(err.to_string())
                })
            }
            Ok(run) => {
                log.exit_code = run.status.and_then(|s| s.code());
                log.stderr = String::from_utf8_lossy(&run.stderr).into_owned();
                let result = interpret(&run, request.model.as_deref());
                if let Err(err) = &result
                    && log.stderr.is_empty()
                {
                    log.stderr = err.detail.clone().unwrap_or_default();
                }
                result
            }
        };
        (result, log)
    }
}

pub fn not_found() -> YagguiError {
    YagguiError::ai_not_configured(
        "Claude Code (claude) was not found. Install it, or set its path in the preferences (AI).",
        "Claude Code (claude) est introuvable. Installe-le, ou indique son chemin dans les préférences (IA).",
    )
}

/// The JSON result of `claude -p --output-format json`, or the failure it reports.
fn interpret(run: &RunOutput, asked_model: Option<&str>) -> Result<ProviderReply, YagguiError> {
    let stdout = String::from_utf8_lossy(&run.stdout);
    let stderr = String::from_utf8_lossy(&run.stderr);
    // The result is the last JSON object printed (a warning line may come first).
    let result = stdout
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .find(|v| v.get("type").and_then(Value::as_str) == Some("result"));
    let Some(result) = result else {
        let detail = if stderr.trim().is_empty() {
            stdout.trim().chars().take(2000).collect::<String>()
        } else {
            stderr.trim().chars().take(2000).collect()
        };
        return Err(classify(None, &detail));
    };
    let text = result
        .get("result")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let is_error = result
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || result
            .get("subtype")
            .and_then(Value::as_str)
            .is_some_and(|s| s != "success")
        || !run.status.is_some_and(|s| s.success());
    if is_error {
        let status = result.get("api_error_status").and_then(Value::as_u64);
        let detail = if text.trim().is_empty() {
            result
                .get("subtype")
                .and_then(Value::as_str)
                .unwrap_or("error")
                .to_owned()
        } else {
            text.trim().chars().take(2000).collect()
        };
        return Err(classify(status, &detail));
    }
    Ok(ProviderReply {
        text,
        model: answering_model(&result).or_else(|| asked_model.map(str::to_owned)),
    })
}

/// The model that wrote most of the answer, from `modelUsage`.
fn answering_model(result: &Value) -> Option<String> {
    result
        .get("modelUsage")
        .and_then(Value::as_object)?
        .iter()
        .max_by_key(|(_, usage)| {
            usage
                .get("outputTokens")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        })
        .map(|(model, _)| model.clone())
}

/// A failure reported by the CLI, from the API status when it gives one, else its text.
fn classify(api_status: Option<u64>, detail: &str) -> YagguiError {
    match api_status {
        Some(401 | 403) => return YagguiError::ai_auth_failed(true, detail),
        Some(429) => return YagguiError::ai_rate_limited(detail),
        Some(408 | 500..=599) => return YagguiError::ai_provider_unavailable(detail),
        _ => {}
    }
    let lower = detail.to_lowercase();
    if [
        "/login",
        "not logged in",
        "invalid api key",
        "authentication",
        "oauth token",
    ]
    .iter()
    .any(|p| lower.contains(p))
    {
        YagguiError::ai_auth_failed(true, detail)
    } else if ["rate limit", "usage limit", "limit reached"]
        .iter()
        .any(|p| lower.contains(p))
    {
        YagguiError::ai_rate_limited(detail)
    } else if [
        "overloaded",
        "connection error",
        "econnrefused",
        "enotfound",
        "network",
    ]
    .iter()
    .any(|p| lower.contains(p))
    {
        YagguiError::ai_provider_unavailable(detail)
    } else {
        YagguiError::ai_provider_failed(detail)
    }
}

#[derive(Debug)]
pub struct RunOutput {
    pub status: Option<ExitStatus>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Debug)]
pub enum RunError {
    Cancelled,
    Timeout,
    Spawn(std::io::Error),
}

/// Runs `binary` with `args` (no shell), `stdin` written from a thread, until it exits, is
/// cancelled or times out; then whatever it left running is killed.
pub fn run(
    binary: &Path,
    args: &[String],
    cwd: Option<&Path>,
    stdin: Option<Vec<u8>>,
    timeout: Duration,
    cancel: &CancelToken,
) -> Result<RunOutput, RunError> {
    if cancel.is_cancelled() {
        return Err(RunError::Cancelled);
    }
    let mut cmd = Command::new(binary);
    shell_env::apply(&mut cmd);
    for name in INHERITED_GIT_ENV {
        cmd.env_remove(name);
    }
    cmd.args(args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    process::isolate(&mut cmd);
    let mut child = cmd.spawn().map_err(RunError::Spawn)?;
    let tree = ProcessTree::attach(&child);

    if let (Some(data), Some(mut pipe)) = (stdin, child.stdin.take()) {
        // A thread, so a program that does not read its input cannot block us; dropping the
        // pipe at the end closes it (end of the prompt).
        thread::spawn(move || {
            let _ = pipe.write_all(&data);
        });
    }
    let stdout = reader(child.stdout.take(), STDOUT_MAX);
    let stderr = reader(child.stderr.take(), STDERR_MAX);

    let deadline = Instant::now() + timeout;
    let status = loop {
        if cancel.is_cancelled() {
            tree.terminate(&mut child);
            return Err(RunError::Cancelled);
        }
        if Instant::now() >= deadline {
            tree.terminate(&mut child);
            return Err(RunError::Timeout);
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => thread::sleep(POLL_INTERVAL),
            Err(_) => {
                tree.terminate(&mut child);
                break None;
            }
        }
    };
    let finished = |grace: Duration| {
        let until = Instant::now() + grace;
        while !(stdout.is_finished() && stderr.is_finished()) && Instant::now() < until {
            thread::sleep(POLL_INTERVAL);
        }
        stdout.is_finished() && stderr.is_finished()
    };
    let mut done = finished(PIPES_GRACE);
    // Background processes it left (a hook, a stuck tool) must not outlive the call.
    tree.kill_remaining();
    if !done {
        done = finished(PIPES_GRACE);
    }
    if !done {
        // Something outside the process tree holds the pipes: its output is not awaited.
        return Ok(RunOutput {
            status,
            stdout: Vec::new(),
            stderr: b"[yaggui] the output stayed open after the program exited".to_vec(),
        });
    }
    Ok(RunOutput {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

fn reader<R: Read + Send + 'static>(pipe: Option<R>, max: usize) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut out = Vec::new();
        if let Some(pipe) = pipe {
            // Past `max`, the rest is drained and dropped so the child never blocks on a full pipe.
            let mut limited = pipe.take(max as u64);
            let _ = limited.read_to_end(&mut out);
            let _ = std::io::copy(&mut limited.into_inner(), &mut std::io::sink());
        }
        out
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::prompt::Prompt;
    use crate::git::errors::ErrorCode;

    #[test]
    fn arguments_keep_the_cli_read_only() {
        let args = ClaudeCode::args(Some("haiku"), true);
        let joined = args.join(" ");
        assert!(joined.starts_with("-p --output-format json --no-session-persistence"));
        assert!(joined.contains("--strict-mcp-config"));
        assert!(joined.contains("--permission-mode dontAsk"));
        assert!(joined.contains("--tools Read,Grep,Glob,Skill"));
        assert!(
            joined.contains("--disallowedTools Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch")
        );
        assert!(joined.ends_with("--model haiku"));
        assert!(!ClaudeCode::args(None, false).join(" ").contains("Skill"));
        assert!(!joined.contains("dangerously"));
    }

    #[test]
    fn input_names_the_skill_and_keeps_the_context_last() {
        let request = GenerationRequest {
            prompt: Prompt {
                system: "INSTRUCTIONS".into(),
                user: "<context>X</context>\n".into(),
            },
            model: None,
            timeout: Duration::from_secs(1),
            workdir: None,
            skill: Some("commit".into()),
        };
        let input = ClaudeCode::input(&request);
        assert!(input.starts_with("INSTRUCTIONS\n\nYou are run by yaggui"));
        assert!(input.contains("\"commit\" skill"));
        assert!(input.ends_with("<context>X</context>\n"));
    }

    fn output(code: i32, stdout: &str, stderr: &str) -> RunOutput {
        #[cfg(unix)]
        let status = {
            use std::os::unix::process::ExitStatusExt;
            ExitStatus::from_raw(code << 8)
        };
        #[cfg(windows)]
        let status = {
            use std::os::windows::process::ExitStatusExt;
            ExitStatus::from_raw(code as u32)
        };
        RunOutput {
            status: Some(status),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[test]
    fn reads_the_json_result() {
        let run = output(
            0,
            "warning: something\n{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"Fix it\",\"modelUsage\":{\"claude-haiku-5-5\":{\"outputTokens\":9},\"claude-opus-5-5\":{\"outputTokens\":1}}}\n",
            "",
        );
        let reply = interpret(&run, Some("haiku")).unwrap();
        assert_eq!(reply.text, "Fix it");
        assert_eq!(reply.model.as_deref(), Some("claude-haiku-5-5"));
    }

    #[test]
    fn maps_cli_failures_to_typed_errors() {
        let error = |code, stdout: &str, stderr: &str| {
            interpret(&output(code, stdout, stderr), None)
                .unwrap_err()
                .code
        };
        assert_eq!(
            error(
                1,
                r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}"#,
                ""
            ),
            ErrorCode::AiAuthFailed
        );
        assert_eq!(
            error(
                1,
                r#"{"type":"result","is_error":true,"api_error_status":429,"result":"x"}"#,
                ""
            ),
            ErrorCode::AiRateLimited
        );
        assert_eq!(
            error(
                1,
                r#"{"type":"result","is_error":true,"api_error_status":529,"result":"x"}"#,
                ""
            ),
            ErrorCode::AiProviderUnavailable
        );
        assert_eq!(
            error(
                0,
                r#"{"type":"result","subtype":"error_max_turns","is_error":false,"result":""}"#,
                ""
            ),
            ErrorCode::AiProviderFailed
        );
        assert_eq!(
            error(1, "", "error: unknown option '--tools'"),
            ErrorCode::AiProviderFailed
        );
        assert_eq!(error(1, "", "Invalid API key"), ErrorCode::AiAuthFailed);
    }

    #[test]
    fn a_missing_program_is_not_configured() {
        let provider = ClaudeCode::new(PathBuf::from("/nonexistent/claude-for-yaggui-tests"));
        let request = GenerationRequest {
            prompt: Prompt {
                system: String::new(),
                user: String::new(),
            },
            model: None,
            timeout: Duration::from_secs(5),
            workdir: None,
            skill: None,
        };
        let (result, log) = provider.generate(&request, &CancelToken::new());
        assert_eq!(result.unwrap_err().code, ErrorCode::AiNotConfigured);
        assert_eq!(log.program, "claude");
    }
}
