//! AI commit messages, end to end: preferences, context, provider, command log, parsing.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::claude_api::{self, ClaudeApi, HttpTransport, UreqTransport};
use super::claude_code::{self, ClaudeCode};
use super::context::{self, ContextInput};
use super::keychain::{OsKeychain, SecretStore};
use super::parse::parse_message;
use super::prompt::Prompt;
use super::provider::{CommitMessageProvider, GenerationRequest, ProviderReply};
use super::types::*;
use crate::events::{BackendEvent, CommandLogged, EventSink};
use crate::git::cli::CancelToken;
use crate::git::errors::YagguiError;
use crate::git::log::{CommandLog, CommandLogEntry, CommandStatus, bounded_output};
use crate::git::read::diff::types::DiffTarget;
use crate::git::redact::redact_urls;
use crate::repo::RepoManager;
use crate::store::Preferences;
use crate::system::shell_env;

/// Longest API key accepted (Anthropic keys are about 110 characters).
const API_KEY_MAX: usize = 512;
/// The provider test needs no long wait.
const TEST_TIMEOUT_MAX: Duration = Duration::from_secs(120);
const TEST_REPLY_MAX_CHARS: usize = 300;

/// Where a variable of the environment is read: yaggui's own, then the login shell's.
pub type EnvLookup = dyn Fn(&str) -> Option<String> + Send + Sync;

pub struct AiService {
    secrets: Arc<dyn SecretStore>,
    transport: Arc<dyn HttpTransport>,
    env: Arc<EnvLookup>,
    log: Arc<CommandLog>,
    sink: Arc<dyn EventSink>,
    /// Generations in flight, by repository.
    running: Mutex<HashMap<u32, CancelToken>>,
}

impl AiService {
    pub fn new(log: Arc<CommandLog>, sink: Arc<dyn EventSink>) -> Self {
        Self::with(
            Arc::new(OsKeychain),
            Arc::new(UreqTransport),
            Arc::new(|name: &str| {
                std::env::var(name)
                    .ok()
                    .filter(|v| !v.trim().is_empty())
                    .or_else(|| shell_env::login_var(name))
            }),
            log,
            sink,
        )
    }

    pub fn with(
        secrets: Arc<dyn SecretStore>,
        transport: Arc<dyn HttpTransport>,
        env: Arc<EnvLookup>,
        log: Arc<CommandLog>,
        sink: Arc<dyn EventSink>,
    ) -> Self {
        Self {
            secrets,
            transport,
            env,
            log,
            sink,
            running: Mutex::default(),
        }
    }

    // ---- Keys --------------------------------------------------------------------------

    /// The key of the Claude API and where it comes from: the keychain first, then
    /// `ANTHROPIC_API_KEY`. A keychain that cannot be read counts as holding none.
    fn api_key(&self) -> (Option<String>, ApiKeySource) {
        let saved = self
            .secrets
            .get(AiProviderKind::ClaudeApi)
            .unwrap_or_else(|err| {
                tracing::warn!(error = %err, "cannot read the keychain");
                None
            })
            .filter(|k| !k.trim().is_empty());
        if let Some(key) = saved {
            return (Some(key), ApiKeySource::Keychain);
        }
        match (self.env)(claude_api::API_KEY_ENV) {
            Some(key) => (Some(key.trim().to_owned()), ApiKeySource::Environment),
            None => (None, ApiKeySource::None),
        }
    }

    pub fn set_api_key(&self, provider: AiProviderKind, key: &str) -> Result<(), YagguiError> {
        if provider != AiProviderKind::ClaudeApi {
            return Err(YagguiError::invalid_argument(
                "This provider does not use an API key.",
                "Ce fournisseur n'utilise pas de clé d'API.",
            ));
        }
        let key = key.trim();
        if key.is_empty() || key.len() > API_KEY_MAX || !key.chars().all(|c| c.is_ascii_graphic()) {
            return Err(YagguiError::invalid_argument(
                "This is not a valid API key.",
                "Ce n'est pas une clé d'API valide.",
            ));
        }
        self.secrets
            .set(provider, key)
            .map_err(YagguiError::ai_keychain_unavailable)
    }

    pub fn clear_api_key(&self, provider: AiProviderKind) -> Result<(), YagguiError> {
        if provider != AiProviderKind::ClaudeApi {
            return Ok(());
        }
        self.secrets
            .delete(provider)
            .map_err(YagguiError::ai_keychain_unavailable)
    }

    // ---- Status ------------------------------------------------------------------------

    pub fn status(&self, prefs: &Preferences) -> AiStatus {
        AiStatus {
            providers: vec![self.claude_api_status(), claude_code_status(prefs)],
        }
    }

    fn claude_api_status(&self) -> AiProviderStatus {
        let (key, source) = self.api_key();
        let keychain_available = self.secrets.available().is_ok();
        AiProviderStatus {
            kind: AiProviderKind::ClaudeApi,
            name: "Claude API".to_owned(),
            default_model: Some(DEFAULT_CLAUDE_API_MODEL.to_owned()),
            suggested_models: claude_api::SUGGESTED_MODELS
                .iter()
                .map(|m| (*m).to_owned())
                .collect(),
            supports_skills: false,
            credential: AiCredential::ApiKey {
                source,
                keychain_available,
                env_var: claude_api::API_KEY_ENV.to_owned(),
            },
            ready: key.is_some(),
            problem: key.is_none().then(no_api_key),
        }
    }

    // ---- Generation --------------------------------------------------------------------

    /// The exact text a generation would send, without sending it.
    pub fn preview(
        &self,
        repos: &RepoManager,
        prefs: &Preferences,
        repo_id: u32,
        request: AiMessageRequest,
    ) -> Result<AiContextPreview, YagguiError> {
        let (input, _) = read_context(repos, prefs, repo_id, request)?;
        let (summary, generation) = build(prefs, request, &input, None);
        let text = sent_text(prefs.ai.provider, &generation);
        Ok(AiContextPreview {
            summary: AiContextSummary {
                sent_bytes: byte_count(text.len()),
                ..summary
            },
            text,
        })
    }

    /// Writes the message for the staged changes of `repo_id`. One generation per repository
    /// at a time; [`cancel`](Self::cancel) stops it.
    pub fn generate(
        &self,
        repos: &RepoManager,
        prefs: &Preferences,
        repo_id: u32,
        request: AiMessageRequest,
    ) -> Result<GeneratedCommitMessage, YagguiError> {
        if !prefs.ai_enabled {
            return Err(YagguiError::ai_disabled());
        }
        let cancel = CancelToken::new();
        let _running = self.start(repo_id, &cancel)?;
        let (input, workdir) = read_context(repos, prefs, repo_id, request)?;
        if input.is_empty() {
            return Err(YagguiError::ai_nothing_staged());
        }
        let provider = self.provider(prefs)?;
        let (mut summary, generation) = build(prefs, request, &input, Some(workdir.clone()));
        let sent = sent_text(prefs.ai.provider, &generation).len();
        summary.sent_bytes = byte_count(sent);
        let started = Instant::now();
        let reply = self.call(
            &provider,
            &generation,
            &cancel,
            Some(repo_id),
            Some(workdir),
            sent,
        )?;
        let (summary_line, description) = parse_message(&reply.text)?;
        Ok(GeneratedCommitMessage {
            summary: summary_line,
            description,
            provider: prefs.ai.provider,
            model: reply.model,
            duration_ms: elapsed_ms(started),
            context: summary,
        })
    }

    /// Sends a tiny prompt with no repository data to `kind`.
    pub fn test(
        &self,
        prefs: &Preferences,
        kind: AiProviderKind,
    ) -> Result<AiTestResult, YagguiError> {
        let prefs = Preferences {
            ai: AiPreferences {
                provider: kind,
                ..prefs.ai.clone()
            },
            ..prefs.clone()
        };
        let provider = self.provider(&prefs)?;
        let generation = GenerationRequest {
            prompt: Prompt {
                system: "You answer a connection test from yaggui, a Git client.".to_owned(),
                user:
                    "Reply with one short sentence saying you are ready to write commit messages."
                        .to_owned(),
            },
            model: model_of(&prefs.ai),
            timeout: timeout_of(&prefs.ai).min(TEST_TIMEOUT_MAX),
            workdir: None,
            skill: None,
        };
        let sent = generation.prompt.bytes();
        let started = Instant::now();
        let reply = self.call(
            &provider,
            &generation,
            &CancelToken::new(),
            None,
            None,
            sent,
        )?;
        Ok(AiTestResult {
            provider: kind,
            model: reply.model,
            duration_ms: elapsed_ms(started),
            reply: reply
                .text
                .trim()
                .chars()
                .take(TEST_REPLY_MAX_CHARS)
                .collect(),
        })
    }

    /// Cancels the generation of `repo_id`, if one is running.
    pub fn cancel(&self, repo_id: u32) {
        if let Some(token) = self.running().get(&repo_id) {
            token.cancel();
        }
    }

    fn running(&self) -> std::sync::MutexGuard<'_, HashMap<u32, CancelToken>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn start(&self, repo_id: u32, cancel: &CancelToken) -> Result<Running<'_>, YagguiError> {
        let mut running = self.running();
        if running.contains_key(&repo_id) {
            return Err(YagguiError::ai_busy());
        }
        running.insert(repo_id, cancel.clone());
        Ok(Running {
            service: self,
            repo_id,
        })
    }

    fn provider(&self, prefs: &Preferences) -> Result<Prepared, YagguiError> {
        Ok(match prefs.ai.provider {
            AiProviderKind::ClaudeApi => {
                let (Some(key), _) = self.api_key() else {
                    return Err(no_api_key());
                };
                let lookup = key.clone();
                Prepared {
                    provider: Box::new(ClaudeApi::new(
                        Arc::clone(&self.transport),
                        Arc::new(move || Ok(Some(lookup.clone()))),
                    )),
                    secret: Some(key),
                }
            }
            AiProviderKind::ClaudeCode => {
                let binary = claude_code::find(prefs.claude_path.as_deref())
                    .ok_or_else(claude_code::not_found)?;
                Prepared {
                    provider: Box::new(ClaudeCode::new(binary)),
                    secret: None,
                }
            }
        })
    }

    /// Runs the provider and records the call in the command log (sizes, never the text).
    fn call(
        &self,
        prepared: &Prepared,
        generation: &GenerationRequest,
        cancel: &CancelToken,
        repo_id: Option<u32>,
        cwd: Option<PathBuf>,
        sent_bytes: usize,
    ) -> Result<ProviderReply, YagguiError> {
        let started_at = unix_seconds();
        let start = Instant::now();
        let (result, call) = prepared.provider.generate(generation, cancel);
        let status = match &result {
            Ok(_) => CommandStatus::Success,
            Err(err) if err.code == crate::git::errors::ErrorCode::Cancelled => {
                CommandStatus::Cancelled
            }
            Err(err) if err.code == crate::git::errors::ErrorCode::AiNotConfigured => {
                CommandStatus::SpawnFailed
            }
            Err(_) => CommandStatus::Failed,
        };
        let mut stdout = format!("[yaggui] sent {sent_bytes} bytes");
        if let Ok(reply) = &result {
            stdout.push_str(&format!(", received {} bytes", reply.text.len()));
            if let Some(model) = &reply.model {
                stdout.push_str(&format!(", model {model}"));
            }
        }
        stdout.push('\n');
        // Masked in case a provider ever echoes the key back in an error.
        let stderr = scrub(&redact_urls(&call.stderr), prepared.secret.as_deref());
        let duration_ms = elapsed_ms(start);
        let (stderr, truncated) = bounded_output(stderr.as_bytes());
        let entry = CommandLogEntry {
            id: 0,
            repo_id,
            program: Some(call.program),
            args: call.args,
            cwd: cwd.map(|p| p.display().to_string()),
            started_at,
            duration_ms,
            exit_code: call.exit_code,
            status,
            stdout,
            stderr,
            truncated,
        };
        tracing::debug!(program = ?entry.program, status = ?entry.status, duration_ms, "ai call");
        let stored = self.log.push(entry);
        self.sink
            .emit(BackendEvent::CommandLogged(CommandLogged { entry: stored }));
        result
    }
}

/// A provider ready to run, with the secret it was given (to mask it in the log).
struct Prepared {
    provider: Box<dyn CommitMessageProvider>,
    secret: Option<String>,
}

/// Removes the repository's entry from the running generations when dropped.
struct Running<'a> {
    service: &'a AiService,
    repo_id: u32,
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.service.running().remove(&self.repo_id);
    }
}

fn claude_code_status(prefs: &Preferences) -> AiProviderStatus {
    let path = claude_code::find(prefs.claude_path.as_deref());
    let version = path.as_deref().and_then(claude_code::version);
    let problem = match (&path, &version) {
        (None, _) => Some(claude_code::not_found()),
        (Some(path), None) => Some(YagguiError::ai_provider_unavailable(format!(
            "{} --version failed",
            path.display()
        ))),
        _ => None,
    };
    AiProviderStatus {
        kind: AiProviderKind::ClaudeCode,
        name: "Claude Code".to_owned(),
        default_model: None,
        suggested_models: claude_code::SUGGESTED_MODELS
            .iter()
            .map(|m| (*m).to_owned())
            .collect(),
        supports_skills: true,
        credential: AiCredential::Cli {
            path: path.map(|p| p.display().to_string()),
            version,
            configured: prefs.claude_path.is_some(),
        },
        ready: problem.is_none(),
        problem,
    }
}

use claude_api::missing_key as no_api_key;

fn read_context(
    repos: &RepoManager,
    prefs: &Preferences,
    repo_id: u32,
    request: AiMessageRequest,
) -> Result<(ContextInput, PathBuf), YagguiError> {
    let session = repos.session(repo_id)?;
    let staged = repos.changed_files(repo_id, &DiffTarget::Staged)?.files;
    let repo = session.repo()?.to_thread_local();
    let input = context::read(&repo, staged, request, &prefs.ai)?;
    Ok((input, session.workdir.clone()))
}

fn build(
    prefs: &Preferences,
    request: AiMessageRequest,
    input: &ContextInput,
    workdir: Option<PathBuf>,
) -> (AiContextSummary, GenerationRequest) {
    let (text, summary) = context::render(input, &prefs.ai);
    let prompt = Prompt::new(&prefs.ai, request, text, !input.recent_subjects.is_empty());
    let skill = match prefs.ai.provider {
        AiProviderKind::ClaudeCode => prefs.ai.claude_code.skill.clone(),
        AiProviderKind::ClaudeApi => None,
    };
    let generation = GenerationRequest {
        prompt,
        model: model_of(&prefs.ai),
        timeout: timeout_of(&prefs.ai),
        workdir,
        skill,
    };
    (summary, generation)
}

/// The text the provider receives: the API gets the instructions and the context as two
/// parts, Claude Code one text on its input.
fn sent_text(kind: AiProviderKind, generation: &GenerationRequest) -> String {
    match kind {
        AiProviderKind::ClaudeApi => generation.prompt.combined(),
        AiProviderKind::ClaudeCode => ClaudeCode::input(generation),
    }
}

fn model_of(ai: &AiPreferences) -> Option<String> {
    match ai.provider {
        AiProviderKind::ClaudeApi => Some(ai.claude_api.model.clone()),
        AiProviderKind::ClaudeCode => ai.claude_code.model.clone(),
    }
}

fn timeout_of(ai: &AiPreferences) -> Duration {
    Duration::from_secs(u64::from(ai.timeout_seconds))
}

/// `text` with every occurrence of `secret` masked.
fn scrub(text: &str, secret: Option<&str>) -> String {
    match secret {
        Some(secret) if secret.len() >= 8 => text.replace(secret, crate::git::redact::MASK),
        _ => text.to_owned(),
    }
}

fn byte_count(bytes: usize) -> u32 {
    u32::try_from(bytes).unwrap_or(u32::MAX)
}

fn unix_seconds() -> u32 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u32::try_from(d.as_secs()).unwrap_or(u32::MAX))
        .unwrap_or(0)
}

fn elapsed_ms(start: Instant) -> u32 {
    u32::try_from(start.elapsed().as_millis()).unwrap_or(u32::MAX)
}
