//! Claude API provider: Anthropic's Messages API with the user's key (F-073).

use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::provider::{CallLog, CommitMessageProvider, GenerationRequest, ProviderReply};
use super::types::AiProviderKind;
use crate::git::cli::CancelToken;
use crate::git::errors::YagguiError;

pub const MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
pub const API_VERSION: &str = "2026-10-21";
pub const API_KEY_ENV: &str = "ANTHROPIC_API_KEY";
/// Room for the model's thinking (on by default on current models) and a long description.
const MAX_TOKENS: u32 = 4096;
/// Answers are a few KB; anything bigger is not a commit message.
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(50);

pub const SUGGESTED_MODELS: [&str; 3] =
    ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];

/// An HTTP answer, whatever its status.
#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    Timeout,
    /// DNS, refused connection, TLS, proxy…
    Network(String),
}

/// Sends the request. The key is a header value the transport must never log.
pub trait HttpTransport: Send + Sync {
    fn post_json(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: Vec<u8>,
        timeout: Duration,
    ) -> Result<HttpResponse, TransportError>;
}

pub struct UreqTransport;

impl HttpTransport for UreqTransport {
    fn post_json(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: Vec<u8>,
        timeout: Duration,
    ) -> Result<HttpResponse, TransportError> {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .https_only(true)
            .http_status_as_error(false)
            .user_agent(concat!("yaggui/", env!("CARGO_PKG_VERSION")))
            .build()
            .new_agent();
        let mut request = agent.post(url).header("content-type", "application/json");
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let mut response = request.send(&body[..]).map_err(transport_error)?;
        let status = response.status().as_u16();
        let body = response
            .body_mut()
            .with_config()
            .limit(MAX_RESPONSE_BYTES)
            .read_to_vec()
            .map_err(transport_error)?;
        Ok(HttpResponse { status, body })
    }
}

fn transport_error(err: ureq::Error) -> TransportError {
    match err {
        ureq::Error::Timeout(_) => TransportError::Timeout,
        other => TransportError::Network(other.to_string()),
    }
}

/// Where the key comes from at the time of a request.
pub type KeyLookup = dyn Fn() -> Result<Option<String>, YagguiError> + Send + Sync;

pub struct ClaudeApi {
    transport: Arc<dyn HttpTransport>,
    url: String,
    key: Arc<KeyLookup>,
}

impl ClaudeApi {
    pub fn new(transport: Arc<dyn HttpTransport>, key: Arc<KeyLookup>) -> Self {
        Self {
            transport,
            url: MESSAGES_URL.to_owned(),
            key,
        }
    }

    #[cfg(test)]
    pub fn with_url(mut self, url: &str) -> Self {
        self.url = url.to_owned();
        self
    }
}

impl CommitMessageProvider for ClaudeApi {
    fn kind(&self) -> AiProviderKind {
        AiProviderKind::ClaudeApi
    }

    fn generate(
        &self,
        request: &GenerationRequest,
        cancel: &CancelToken,
    ) -> (Result<ProviderReply, YagguiError>, CallLog) {
        let model = request.model.clone().unwrap_or_default();
        let log = CallLog {
            program: "claude-api".to_owned(),
            args: vec!["messages".to_owned(), "--model".to_owned(), model.clone()],
            exit_code: None,
            stderr: String::new(),
        };
        let key = match (self.key)() {
            Ok(Some(key)) => key,
            Ok(None) => return (Err(missing_key()), log),
            Err(err) => return (Err(err), log),
        };
        let body = json!({
            "model": model,
            "max_tokens": MAX_TOKENS,
            "system": request.prompt.system,
            "messages": [{ "role": "user", "content": request.prompt.user }],
        });
        let body = match serde_json::to_vec(&body) {
            Ok(body) => body,
            Err(err) => return (Err(YagguiError::internal(err.to_string())), log),
        };

        // The request runs on its own thread so a cancellation returns at once; its result is
        // dropped when it arrives (bounded by the timeout).
        let (tx, rx) = mpsc::channel();
        let transport = Arc::clone(&self.transport);
        let url = self.url.clone();
        let timeout = request.timeout;
        let spawned = std::thread::Builder::new()
            .name("ai-request".into())
            .spawn(move || {
                let headers = [
                    ("x-api-key", key.as_str()),
                    ("anthropic-version", API_VERSION),
                ];
                let _ = tx.send(transport.post_json(&url, &headers, body, timeout));
            });
        if let Err(err) = spawned {
            return (Err(YagguiError::internal(err.to_string())), log);
        }
        let deadline = Instant::now() + timeout + Duration::from_secs(1);
        let answer = loop {
            if cancel.is_cancelled() {
                return (Err(YagguiError::cancelled()), log);
            }
            match rx.recv_timeout(POLL_INTERVAL) {
                Ok(answer) => break answer,
                Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() < deadline => {}
                Err(mpsc::RecvTimeoutError::Timeout) => break Err(TransportError::Timeout),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    break Err(TransportError::Network("request thread ended".to_owned()));
                }
            }
        };
        let mut log = log;
        let result = match answer {
            Err(TransportError::Timeout) => {
                log.stderr = "timed out".to_owned();
                Err(YagguiError::ai_timeout(request.timeout.as_secs() as u32))
            }
            Err(TransportError::Network(detail)) => {
                log.stderr = detail.clone();
                Err(YagguiError::ai_provider_unavailable(detail))
            }
            Ok(response) => {
                log.exit_code = Some(i32::from(response.status));
                let result = interpret(response, &model);
                if let Err(err) = &result {
                    log.stderr = err.detail.clone().unwrap_or_default();
                }
                result
            }
        };
        (result, log)
    }
}

pub fn missing_key() -> YagguiError {
    YagguiError::ai_not_configured(
        "No API key: save one in the preferences (AI), or set ANTHROPIC_API_KEY.",
        "Aucune clé d'API : enregistres-en une dans les préférences (IA), ou définis ANTHROPIC_API_KEY.",
    )
}

/// Maps an HTTP answer of the Messages API to the reply or a typed error.
pub fn interpret(response: HttpResponse, model: &str) -> Result<ProviderReply, YagguiError> {
    let json: Option<Value> = serde_json::from_slice(&response.body).ok();
    if response.status != 200 {
        let (kind, message) = json
            .as_ref()
            .and_then(|j| j.get("error"))
            .map(|e| {
                (
                    e.get("type")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    e.get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                )
            })
            .unwrap_or_default();
        let detail = if message.is_empty() {
            format!("HTTP {}", response.status)
        } else {
            format!("HTTP {} {kind}: {message}", response.status)
        };
        return Err(match response.status {
            401 | 403 => YagguiError::ai_auth_failed(false, detail),
            429 => YagguiError::ai_rate_limited(detail),
            408 | 500..=599 => YagguiError::ai_provider_unavailable(detail),
            // 402 billing, 400 invalid request (unknown model), 404 model not found, 413.
            _ => YagguiError::ai_provider_failed(detail),
        });
    }
    let Some(json) = json else {
        return Err(YagguiError::ai_provider_failed("the answer is not JSON"));
    };
    if json.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
        return Err(YagguiError::ai_provider_failed(
            "the model declined to answer (stop_reason: refusal)",
        ));
    }
    let text: String = json
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    let answered_by = json
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(model)
        .to_owned();
    Ok(ProviderReply {
        text,
        model: Some(answered_by),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::ai::prompt::Prompt;
    use crate::git::errors::ErrorCode;

    type Captured = Mutex<Vec<(String, Vec<(String, String)>, Value)>>;

    struct Fake {
        answer: Mutex<Option<Result<HttpResponse, TransportError>>>,
        delay: Duration,
        seen: Captured,
    }

    impl Fake {
        fn new(answer: Result<HttpResponse, TransportError>) -> Arc<Self> {
            Arc::new(Self {
                answer: Mutex::new(Some(answer)),
                delay: Duration::ZERO,
                seen: Mutex::default(),
            })
        }
    }

    impl HttpTransport for Fake {
        fn post_json(
            &self,
            url: &str,
            headers: &[(&str, &str)],
            body: Vec<u8>,
            _timeout: Duration,
        ) -> Result<HttpResponse, TransportError> {
            std::thread::sleep(self.delay);
            self.seen.lock().unwrap().push((
                url.to_owned(),
                headers
                    .iter()
                    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                    .collect(),
                serde_json::from_slice(&body).unwrap(),
            ));
            self.answer.lock().unwrap().take().unwrap()
        }
    }

    fn request() -> GenerationRequest {
        GenerationRequest {
            prompt: Prompt {
                system: "SYSTEM".into(),
                user: "CONTEXT".into(),
            },
            model: Some("claude-haiku-5-5".into()),
            timeout: Duration::from_secs(5),
            workdir: None,
            skill: None,
        }
    }

    fn api(fake: Arc<Fake>, key: Option<&str>) -> ClaudeApi {
        let key = key.map(str::to_owned);
        ClaudeApi::new(fake, Arc::new(move || Ok(key.clone())))
    }

    fn ok(body: Value) -> Result<HttpResponse, TransportError> {
        Ok(HttpResponse {
            status: 200,
            body: serde_json::to_vec(&body).unwrap(),
        })
    }

    fn status(code: u16, kind: &str) -> Result<HttpResponse, TransportError> {
        Ok(HttpResponse {
            status: code,
            body: serde_json::to_vec(
                &json!({"type": "error", "error": {"type": kind, "message": "nope"}}),
            )
            .unwrap(),
        })
    }

    #[test]
    fn sends_the_messages_request_and_reads_the_text_blocks() {
        let fake = Fake::new(ok(json!({
            "model": "claude-haiku-5-5",
            "stop_reason": "end_turn",
            "content": [
                {"type": "thinking", "thinking": ""},
                {"type": "text", "text": "Add the button\n\nBody."}
            ]
        })));
        let (reply, log) =
            api(Arc::clone(&fake), Some("sk-secret")).generate(&request(), &CancelToken::new());
        let reply = reply.unwrap();
        assert_eq!(reply.text, "Add the button\n\nBody.");
        assert_eq!(reply.model.as_deref(), Some("claude-haiku-5-5"));
        let seen = fake.seen.lock().unwrap();
        let (url, headers, body) = &seen[0];
        assert_eq!(url, MESSAGES_URL);
        assert!(headers.contains(&("x-api-key".into(), "sk-secret".into())));
        assert!(headers.contains(&("anthropic-version".into(), API_VERSION.into())));
        assert_eq!(body["model"], "claude-haiku-5-5");
        assert_eq!(body["system"], "SYSTEM");
        assert_eq!(body["messages"][0]["content"], "CONTEXT");
        assert!(body.get("temperature").is_none());
        // The key never reaches the log.
        assert!(!format!("{log:?}").contains("sk-secret"));
        assert_eq!(log.exit_code, Some(200));
    }

    #[test]
    fn maps_http_failures_to_typed_errors() {
        let cases = [
            (status(401, "authentication_error"), ErrorCode::AiAuthFailed),
            (status(403, "permission_error"), ErrorCode::AiAuthFailed),
            (status(429, "rate_limit_error"), ErrorCode::AiRateLimited),
            (
                status(529, "overloaded_error"),
                ErrorCode::AiProviderUnavailable,
            ),
            (status(500, "api_error"), ErrorCode::AiProviderUnavailable),
            (
                status(400, "invalid_request_error"),
                ErrorCode::AiProviderFailed,
            ),
            (status(404, "not_found_error"), ErrorCode::AiProviderFailed),
            (Err(TransportError::Timeout), ErrorCode::AiTimeout),
            (
                Err(TransportError::Network("dns".into())),
                ErrorCode::AiProviderUnavailable,
            ),
            (
                ok(json!({"stop_reason": "refusal", "content": []})),
                ErrorCode::AiProviderFailed,
            ),
        ];
        for (answer, code) in cases {
            let (result, _) =
                api(Fake::new(answer), Some("k")).generate(&request(), &CancelToken::new());
            assert_eq!(result.unwrap_err().code, code);
        }
        let (result, _) =
            api(Fake::new(status(400, "x")), Some("k")).generate(&request(), &CancelToken::new());
        assert_eq!(
            result.unwrap_err().detail.as_deref(),
            Some("HTTP 400 x: nope")
        );
    }

    #[test]
    fn needs_a_key() {
        let fake = Fake::new(ok(json!({})));
        let (result, _) = api(Arc::clone(&fake), None).generate(&request(), &CancelToken::new());
        assert_eq!(result.unwrap_err().code, ErrorCode::AiNotConfigured);
        assert!(fake.seen.lock().unwrap().is_empty());
    }

    #[test]
    fn cancellation_returns_without_waiting_for_the_answer() {
        let fake = Arc::new(Fake {
            answer: Mutex::new(Some(ok(json!({"content": []})))),
            delay: Duration::from_secs(3),
            seen: Mutex::default(),
        });
        let cancel = CancelToken::new();
        let cancel_later = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            cancel_later.cancel();
        });
        let start = Instant::now();
        let (result, _) = api(fake, Some("k"))
            .with_url("https://example.invalid")
            .generate(&request(), &cancel);
        assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}
