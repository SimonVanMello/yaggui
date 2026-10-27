//! The provider abstraction (F-073): a provider turns a prompt into an answer. Context, prompt
//! and parsing are shared; a new provider (Codex CLI, another API) is one more implementation.

use std::path::PathBuf;
use std::time::Duration;

use super::prompt::Prompt;
use super::types::AiProviderKind;
use crate::git::cli::CancelToken;
use crate::git::errors::YagguiError;

pub struct GenerationRequest {
    pub prompt: Prompt,
    /// Model id; `None` lets the provider choose.
    pub model: Option<String>,
    pub timeout: Duration,
    /// Worktree of the repository, for a provider that runs in it (Claude Code); `None` for
    /// the provider test.
    pub workdir: Option<PathBuf>,
    /// Claude Code skill to use.
    pub skill: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderReply {
    /// Raw answer, parsed by `parse::parse_message`.
    pub text: String,
    /// Model that answered, when known.
    pub model: Option<String>,
}

/// What the command log shows of a call: never the key, never the prompt.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CallLog {
    /// `claude`, or a pseudo-program for an API (`claude-api`).
    pub program: String,
    pub args: Vec<String>,
    /// Process exit code, or HTTP status for an API.
    pub exit_code: Option<i32>,
    /// What went wrong, for the log (bounded by the log itself).
    pub stderr: String,
}

pub trait CommitMessageProvider: Send + Sync {
    fn kind(&self) -> AiProviderKind;

    /// Sends the prompt and waits for the answer, giving up on `cancel` or after the
    /// request's timeout. Blocking: callers run it off the async runtime. The log is
    /// returned whatever the outcome.
    fn generate(
        &self,
        request: &GenerationRequest,
        cancel: &CancelToken,
    ) -> (Result<ProviderReply, YagguiError>, CallLog);
}
