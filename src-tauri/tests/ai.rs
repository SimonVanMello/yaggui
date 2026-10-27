//! AI commit messages (M10-1) on temporary repositories: the context is read without changing
//! anything, the providers get what the preferences allow, and nothing is ever committed.

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{Fixture, RecordingSink};
use serde_json::{Value, json};
use yaggui_lib::ai::claude_api::{HttpResponse, HttpTransport, TransportError};
use yaggui_lib::ai::keychain::{MemorySecrets, SecretStore};
use yaggui_lib::ai::{
    AiCredential, AiMessageRequest, AiPreferences, AiProviderKind, AiService, ApiKeySource,
};
use yaggui_lib::events::BackendEvent;
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::errors::ErrorCode;
use yaggui_lib::git::log::{CommandLog, CommandStatus};
use yaggui_lib::repo::RepoManager;
use yaggui_lib::store::{Preferences, Store};

/// Records the requests and answers with a canned message.
struct FakeApi {
    answer: String,
    bodies: Mutex<Vec<Value>>,
}

impl HttpTransport for FakeApi {
    fn post_json(
        &self,
        _url: &str,
        _headers: &[(&str, &str)],
        body: Vec<u8>,
        _timeout: Duration,
    ) -> Result<HttpResponse, TransportError> {
        self.bodies
            .lock()
            .unwrap()
            .push(serde_json::from_slice(&body).unwrap());
        Ok(HttpResponse {
            status: 200,
            body: serde_json::to_vec(&json!({
                "model": "claude-haiku-5-5",
                "stop_reason": "end_turn",
                "content": [{ "type": "text", "text": self.answer }],
            }))
            .unwrap(),
        })
    }
}

struct Env {
    fx: Fixture,
    sink: Arc<RecordingSink>,
    log: Arc<CommandLog>,
    repos: Arc<RepoManager>,
    api: Arc<FakeApi>,
    ai: AiService,
    id: u32,
}

fn env() -> Env {
    let fx = Fixture::new("clean");
    fx.git(&["config", "user.name", "yaggui Tests"]);
    fx.git(&["config", "user.email", "tests@yaggui.dev"]);
    let sink = Arc::new(RecordingSink::default());
    let log = Arc::new(CommandLog::new());
    let git = GitCli::new(Arc::clone(&log), sink.clone())
        .with_env("GIT_CONFIG_NOSYSTEM", "1")
        .with_env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        );
    let store = Arc::new(Store::open_in_memory().unwrap());
    let repos = Arc::new(RepoManager::new(Arc::new(git), store, sink.clone()).without_watcher());
    let id = repos.open(&fx.repo_str()).unwrap().id;
    let api = Arc::new(FakeApi {
        answer: "Here is the commit message:\n\n```\nAdd notes and update src\n\nExplain why.\n```"
            .to_owned(),
        bodies: Mutex::default(),
    });
    let secrets = Arc::new(MemorySecrets::default());
    secrets
        .set(AiProviderKind::ClaudeApi, "sk-ant-test-key-123456")
        .unwrap();
    let ai = AiService::with(
        secrets,
        api.clone(),
        Arc::new(|_: &str| None),
        Arc::clone(&log),
        sink.clone(),
    );
    Env {
        fx,
        sink,
        log,
        repos,
        api,
        ai,
        id,
    }
}

fn enabled() -> Preferences {
    Preferences {
        ai_enabled: true,
        ..Preferences::default()
    }
}

/// Stages a modified file, a new file, a lockfile and a binary file.
fn stage_changes(fx: &Fixture) {
    let repo = fx.repo();
    std::fs::write(repo.join("src.txt"), "line 1\nline 2\n").unwrap();
    std::fs::write(repo.join("notes.md"), "# Notes\n").unwrap();
    std::fs::write(repo.join("Cargo.lock"), "lock content\n").unwrap();
    std::fs::write(
        repo.join("logo.png"),
        [0x89, b'P', b'N', b'G', 0, 1, 2, 0, 3],
    )
    .unwrap();
    fx.git(&["add", "src.txt", "notes.md", "Cargo.lock", "logo.png"]);
}

/// Everything a write would change: HEAD, refs, the index file, the worktree status.
fn snapshot(fx: &Fixture) -> (Vec<u8>, String, String, String) {
    let repo = fx.repo();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(&repo)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    };
    (
        std::fs::read(repo.join(".git/index")).unwrap(),
        git(&["rev-parse", "HEAD"]),
        git(&["for-each-ref"]),
        git(&[
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "--untracked-files=all",
        ]),
    )
}

#[test]
fn generation_reads_the_staged_changes_and_changes_nothing() {
    let env = env();
    stage_changes(&env.fx);
    let before = snapshot(&env.fx);

    let message = env
        .ai
        .generate(&env.repos, &enabled(), env.id, AiMessageRequest::default())
        .unwrap();
    assert_eq!(message.summary, "Add notes and update src");
    assert_eq!(message.description, "Explain why.");
    assert_eq!(message.provider, AiProviderKind::ClaudeApi);
    assert_eq!(message.model.as_deref(), Some("claude-haiku-5-5"));
    assert_eq!(message.context.files, 4);
    assert_eq!(message.context.excluded_files, vec!["Cargo.lock"]);
    assert_eq!(message.context.binary_files, vec!["logo.png"]);

    let bodies = env.api.bodies.lock().unwrap();
    let body = &bodies[0];
    assert_eq!(body["model"], "claude-haiku-5-5");
    let context = body["messages"][0]["content"].as_str().unwrap();
    assert!(context.contains("Branch: main"));
    assert!(context.contains("- add src"), "{context}");
    assert!(context.contains("+line 2"));
    assert!(context.contains("A notes.md"));
    assert!(context.contains("Cargo.lock (+1 -0) [diff not sent: excluded]"));
    assert!(!context.contains("lock content"));
    assert!(context.contains("logo.png [binary]"));
    assert!(body["system"].as_str().unwrap().contains("imperative mood"));

    // Nothing was written: same index, HEAD, refs and status.
    assert_eq!(snapshot(&env.fx), before);

    // The call is in the command log, with sizes and without the key or the diff.
    let entry = env
        .log
        .entries()
        .into_iter()
        .find(|e| e.program.as_deref() == Some("claude-api"))
        .unwrap();
    assert_eq!(entry.status, CommandStatus::Success);
    assert_eq!(entry.repo_id, Some(env.id));
    assert!(entry.stdout.contains("sent "));
    let logged = format!("{entry:?}");
    assert!(!logged.contains("sk-ant-test-key"));
    assert!(!logged.contains("line 2"));
    assert!(env.sink.events().iter().any(|e| matches!(
        e,
        BackendEvent::CommandLogged(logged) if logged.entry.program.as_deref() == Some("claude-api")
    )));
}

#[test]
fn preview_matches_what_is_sent_and_covers_the_amended_commit() {
    let env = env();
    stage_changes(&env.fx);
    let request = AiMessageRequest {
        amend: true,
        conventional: true,
    };
    let preview = env
        .ai
        .preview(&env.repos, &Preferences::default(), env.id, request)
        .unwrap();
    assert!(
        preview
            .text
            .contains("Changes of the commit being amended (HEAD)")
    );
    // HEAD ("add src") added src.txt; its subject is not offered as a style example.
    assert!(preview.text.contains("+line 1"));
    assert!(!preview.text.contains("- add src"));
    assert!(preview.text.contains("- initial commit"));
    assert!(preview.text.contains("Conventional Commits"));
    assert_eq!(preview.summary.sent_bytes as usize, preview.text.len());
    // The preview sends nothing.
    assert!(env.api.bodies.lock().unwrap().is_empty());

    env.ai
        .generate(&env.repos, &enabled(), env.id, request)
        .unwrap();
    let body = &env.api.bodies.lock().unwrap()[0];
    let sent = format!(
        "{}\n{}",
        body["system"].as_str().unwrap(),
        body["messages"][0]["content"].as_str().unwrap()
    );
    assert_eq!(sent, preview.text);
}

#[test]
fn refuses_when_off_unconfigured_or_nothing_staged() {
    let env = env();
    let err = env
        .ai
        .generate(
            &env.repos,
            &Preferences::default(),
            env.id,
            AiMessageRequest::default(),
        )
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::AiDisabled);

    let err = env
        .ai
        .generate(&env.repos, &enabled(), env.id, AiMessageRequest::default())
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NothingToCommit);

    stage_changes(&env.fx);
    let no_key = AiService::with(
        Arc::new(MemorySecrets::unavailable()),
        env.api.clone(),
        Arc::new(|_: &str| None),
        Arc::clone(&env.log),
        env.sink.clone(),
    );
    let err = no_key
        .generate(&env.repos, &enabled(), env.id, AiMessageRequest::default())
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::AiNotConfigured);
    assert!(env.api.bodies.lock().unwrap().is_empty());
}

#[test]
fn api_key_from_the_keychain_or_the_environment_never_returned() {
    let env = env();
    let secrets = Arc::new(MemorySecrets::default());
    let ai = AiService::with(
        secrets.clone(),
        env.api.clone(),
        Arc::new(|name: &str| (name == "ANTHROPIC_API_KEY").then(|| "sk-env-1234567".to_owned())),
        Arc::clone(&env.log),
        env.sink.clone(),
    );
    let source = |ai: &AiService| match &ai.status(&Preferences::default()).providers[0].credential
    {
        AiCredential::ApiKey { source, .. } => *source,
        AiCredential::Cli { .. } => panic!("not the API provider"),
    };
    assert_eq!(source(&ai), ApiKeySource::Environment);
    ai.set_api_key(AiProviderKind::ClaudeApi, "  sk-saved-1234567  ")
        .unwrap();
    assert_eq!(
        secrets.get(AiProviderKind::ClaudeApi).unwrap().as_deref(),
        Some("sk-saved-1234567")
    );
    assert_eq!(source(&ai), ApiKeySource::Keychain);
    let status = serde_json::to_string(&ai.status(&Preferences::default())).unwrap();
    assert!(!status.contains("sk-saved") && !status.contains("sk-env"));
    ai.clear_api_key(AiProviderKind::ClaudeApi).unwrap();
    assert_eq!(source(&ai), ApiKeySource::Environment);

    for bad in ["", "two words", "é-key"] {
        assert_eq!(
            ai.set_api_key(AiProviderKind::ClaudeApi, bad)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
    }
    let locked = AiService::with(
        Arc::new(MemorySecrets::unavailable()),
        env.api.clone(),
        Arc::new(|_: &str| None),
        Arc::clone(&env.log),
        env.sink.clone(),
    );
    assert_eq!(
        locked
            .set_api_key(AiProviderKind::ClaudeApi, "sk-1234567")
            .unwrap_err()
            .code,
        ErrorCode::AiKeychainUnavailable
    );
}

/// A fake `claude` that records its arguments, folder and input, then answers like
/// `claude -p --output-format json`, optionally after a delay (with a child process).
#[cfg(unix)]
fn fake_claude(dir: &Path, delay: u32) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join("claude");
    let record = dir.display();
    std::fs::write(
        &script,
        format!(
            r#"#!/bin/sh
printf '%s\n' "$@" > '{record}/args'
pwd > '{record}/cwd'
cat > '{record}/stdin'
if [ {delay} -gt 0 ]; then
  sleep {delay} &
  echo $! > '{record}/child'
  wait
fi
printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"result":"Update src\n\nFrom Claude Code.","modelUsage":{{"claude-haiku-5-5":{{"outputTokens":5}}}}}}'
"#
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script
}

#[cfg(unix)]
fn claude_code_prefs(script: &Path) -> Preferences {
    Preferences {
        ai_enabled: true,
        claude_path: Some(script.display().to_string()),
        ai: AiPreferences {
            provider: AiProviderKind::ClaudeCode,
            claude_code: yaggui_lib::ai::ClaudeCodeSettings {
                model: Some("haiku".into()),
                skill: Some("commit".into()),
            },
            ..AiPreferences::default()
        },
        ..Preferences::default()
    }
}

#[cfg(unix)]
#[test]
fn claude_code_runs_read_only_in_the_worktree() {
    let env = env();
    stage_changes(&env.fx);
    let before = snapshot(&env.fx);
    let bin = tempfile::tempdir().unwrap();
    let script = fake_claude(bin.path(), 0);

    let message = env
        .ai
        .generate(
            &env.repos,
            &claude_code_prefs(&script),
            env.id,
            AiMessageRequest::default(),
        )
        .unwrap();
    assert_eq!(message.summary, "Update src");
    assert_eq!(message.description, "From Claude Code.");
    assert_eq!(message.model.as_deref(), Some("claude-haiku-5-5"));

    let read = |name: &str| std::fs::read_to_string(bin.path().join(name)).unwrap();
    let args: Vec<String> = read("args").lines().map(str::to_owned).collect();
    let arg_after = |flag: &str| {
        let i = args.iter().position(|a| a == flag).unwrap();
        args[i + 1].clone()
    };
    assert_eq!(args[0], "-p");
    assert_eq!(arg_after("--output-format"), "json");
    assert_eq!(arg_after("--permission-mode"), "dontAsk");
    assert_eq!(arg_after("--tools"), "Read,Grep,Glob,Skill");
    assert_eq!(arg_after("--model"), "haiku");
    let denied = arg_after("--disallowedTools");
    for tool in ["Bash", "Edit", "Write", "NotebookEdit"] {
        assert!(denied.split(',').any(|t| t == tool), "{tool} not denied");
    }
    assert!(args.contains(&"--strict-mcp-config".to_owned()));
    assert!(args.contains(&"--no-session-persistence".to_owned()));
    assert!(
        !args
            .iter()
            .any(|a| a.contains("dangerously") || a.contains("bypass"))
    );
    // The prompt went on stdin, not in an argument.
    assert!(!args.iter().any(|a| a.contains("+line 2")));
    let stdin = read("stdin");
    assert!(stdin.contains("+line 2"));
    assert!(stdin.contains("\"commit\" skill"));
    assert!(stdin.contains("never stage"));
    assert_eq!(
        Path::new(read("cwd").trim()).canonicalize().unwrap(),
        env.fx.repo().canonicalize().unwrap()
    );
    assert_eq!(snapshot(&env.fx), before);

    let entry = env
        .log
        .entries()
        .into_iter()
        .find(|e| e.program.as_deref() == Some("claude"))
        .unwrap();
    assert_eq!(entry.status, CommandStatus::Success);
    assert_eq!(entry.args, args);
    assert!(!entry.stdout.contains("line 2"));
}

#[cfg(unix)]
#[test]
fn claude_code_is_cancelled_with_its_children_and_one_runs_per_repo() {
    let env = Arc::new(env());
    stage_changes(&env.fx);
    let bin = tempfile::tempdir().unwrap();
    let script = fake_claude(bin.path(), 30);
    let prefs = claude_code_prefs(&script);

    let running = {
        let env = Arc::clone(&env);
        let prefs = prefs.clone();
        std::thread::spawn(move || {
            env.ai
                .generate(&env.repos, &prefs, env.id, AiMessageRequest::default())
        })
    };
    let child_file = bin.path().join("child");
    let start = std::time::Instant::now();
    while !child_file.exists() && start.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_millis(50));
    let busy = env
        .ai
        .generate(&env.repos, &prefs, env.id, AiMessageRequest::default())
        .unwrap_err();
    assert_eq!(busy.code, ErrorCode::AiBusy);

    env.ai.cancel(env.id);
    let err = running.join().unwrap().unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);
    assert!(start.elapsed() < Duration::from_secs(10));
    let child: i32 = std::fs::read_to_string(&child_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    // The `sleep` the script started is gone too (a zombie waiting for a reaper is dead).
    let alive = || {
        let status = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &child.to_string()])
            .output()
            .unwrap();
        let state = String::from_utf8_lossy(&status.stdout);
        status.status.success() && !state.trim().starts_with('Z')
    };
    let start_wait = std::time::Instant::now();
    while alive() && start_wait.elapsed() < Duration::from_secs(3) {
        std::thread::sleep(Duration::from_millis(20));
    }
    let alive = alive();
    assert!(!alive, "the child process survived the cancellation");
    assert!(env.log.entries().iter().any(|e| e.program.as_deref() == Some("claude")
        && e.status == CommandStatus::Cancelled));

    // Free again once cancelled.
    let quick = fake_claude(bin.path(), 0);
    env.ai
        .generate(
            &env.repos,
            &claude_code_prefs(&quick),
            env.id,
            AiMessageRequest::default(),
        )
        .unwrap();
}
