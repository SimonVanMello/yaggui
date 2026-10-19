//! Credentials embedded in remote URLs never reach the command log, the errors or the lists
//! the front displays. The remote is an https URL to a local port nothing listens on: the
//! command fails at once, with no network access.

mod common;

use std::net::TcpListener;
use std::sync::Arc;

use common::{Fixture, RecordingSink};
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::errors::YagguiError;
use yaggui_lib::git::log::{CommandLog, CommandLogEntry};
use yaggui_lib::git::ops::types::FetchTarget;
use yaggui_lib::repo::RepoManager;
use yaggui_lib::repo::create::{CloneRequest, RepoCreator};
use yaggui_lib::store::Store;

const SECRET: &str = "s3cr3t-t0ken";

struct Env {
    fx: Fixture,
    log: Arc<CommandLog>,
    git: Arc<GitCli>,
    store: Arc<Store>,
    sink: Arc<RecordingSink>,
    repos: RepoManager,
    id: u32,
    url: String,
}

fn closed_port_url(userinfo: &str) -> String {
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    format!("https://{userinfo}@127.0.0.1:{port}/org/repo.git")
}

fn env() -> Env {
    let fx = Fixture::new("clean");
    let sink = Arc::new(RecordingSink::default());
    let log = Arc::new(CommandLog::new());
    let mut cli = GitCli::new(log.clone(), sink.clone());
    for (name, value) in [
        ("GIT_CONFIG_NOSYSTEM", "1"),
        (
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        ),
        // The test machine may force a proxy; the target is local.
        ("NO_PROXY", "*"),
        ("no_proxy", "*"),
    ] {
        cli = cli.with_env(name, value);
    }
    let git = Arc::new(cli);
    let store = Arc::new(Store::open_in_memory().unwrap());
    let repos = RepoManager::new(git.clone(), store.clone(), sink.clone()).without_watcher();
    let id = repos.open(&fx.repo_str()).unwrap().id;
    Env {
        fx,
        log,
        git,
        store,
        sink,
        repos,
        id,
        url: closed_port_url(&format!("alice:{SECRET}")),
    }
}

fn assert_no_secret(entries: &[CommandLogEntry]) {
    for entry in entries {
        let all = format!("{:?}", entry);
        assert!(!all.contains(SECRET), "secret in log entry: {all}");
    }
}

fn assert_error_clean(error: &YagguiError) {
    let all = format!("{error:?}");
    assert!(!all.contains(SECRET), "secret in error: {all}");
}

fn redacted(url: &str) -> String {
    url.replace(SECRET, "***")
}

#[test]
fn failed_fetch_leaves_no_secret_in_log_or_error() {
    let env = env();
    env.repos
        .add_remote(env.id, "upstream", &env.url, Some(env.url.clone()))
        .unwrap();
    let error = env
        .repos
        .fetch(env.id, FetchTarget::All, false)
        .expect_err("nothing listens on that port");
    assert_error_clean(&error);

    let entries = env.log.entries();
    assert_no_secret(&entries);
    let add = entries
        .iter()
        .find(|e| e.args.starts_with(&["remote".to_owned(), "add".to_owned()]))
        .expect("remote add is logged");
    assert!(add.args.contains(&redacted(&env.url)), "{:?}", add.args);
    assert!(entries.iter().any(|e| e.args[0] == "fetch"));
    // The secret is stored for Git, which needs it to authenticate.
    let stored = std::process::Command::new("git")
        .args(["config", "--get", "remote.upstream.url"])
        .current_dir(env.fx.repo())
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&stored.stdout).trim(), env.url);
}

#[test]
fn failed_clone_leaves_no_secret_in_log_or_error() {
    let env = env();
    let work = tempfile::tempdir().unwrap();
    let creator = RepoCreator::new(env.git.clone(), env.store.clone(), env.sink.clone());
    let error = creator
        .clone_repo(&CloneRequest {
            clone_id: "clone-1".into(),
            url: env.url.clone(),
            target: work.path().join("out").display().to_string(),
            branch: None,
            depth: None,
            recurse_submodules: false,
        })
        .expect_err("nothing listens on that port");
    assert_error_clean(&error);

    let entries = env.log.entries();
    let clone = entries
        .iter()
        .find(|e| e.args.iter().any(|a| a == "clone"))
        .expect("clone is logged");
    assert!(clone.args.contains(&redacted(&env.url)), "{:?}", clone.args);
    assert_no_secret(&entries);
}

#[test]
fn remote_lists_are_masked_and_an_unchanged_url_keeps_its_secret() {
    let env = env();
    env.repos
        .add_remote(env.id, "upstream", &env.url, Some(env.url.clone()))
        .unwrap();
    let refs = env.repos.list_refs(env.id).unwrap();
    let remote = refs.remotes.iter().find(|r| r.name == "upstream").unwrap();
    assert_eq!(remote.url.as_deref(), Some(redacted(&env.url).as_str()));
    assert_eq!(
        remote.push_url.as_deref(),
        Some(redacted(&env.url).as_str())
    );

    // The dialog sends back what it displayed.
    let shown = redacted(&env.url);
    env.repos
        .set_remote_urls(env.id, "upstream", &shown, Some(shown.clone()))
        .unwrap();
    let config = |key: &str| {
        let out = std::process::Command::new("git")
            .args(["config", "--get", key])
            .current_dir(env.fx.repo())
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    };
    assert_eq!(config("remote.upstream.url"), env.url);
    assert_eq!(config("remote.upstream.pushurl"), env.url);
    assert_no_secret(&env.log.entries());
}
