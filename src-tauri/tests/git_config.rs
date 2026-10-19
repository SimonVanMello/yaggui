//! Git configuration editor (F-325) and external tool checks (F-323) on temporary
//! repositories and a temporary global config: each test checks the resulting Git state.

mod common;

use std::path::PathBuf;
use std::sync::Arc;

use common::{Fixture, RecordingSink};
use yaggui_lib::events::{BackendEvent, OpKind, OpOutcome};
use yaggui_lib::git::cli::GitCli;
use yaggui_lib::git::errors::ErrorCode;
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::ops::config::{ExternalToolKind, ToolIssue};
use yaggui_lib::git::ops::types::ConfigScope;
use yaggui_lib::repo::RepoManager;
use yaggui_lib::store::Store;

struct Env {
    fx: Fixture,
    sink: Arc<RecordingSink>,
    repos: Arc<RepoManager>,
    store: Arc<Store>,
    global: PathBuf,
    id: u32,
}

fn env() -> Env {
    let fx = Fixture::new("clean");
    let global = fx.root.join("global-gitconfig");
    let sink = Arc::new(RecordingSink::default());
    let git = GitCli::new(Arc::new(CommandLog::new()), sink.clone())
        .with_env("GIT_CONFIG_NOSYSTEM", "1")
        .with_env("GIT_CONFIG_GLOBAL", &global);
    let store = Arc::new(Store::open_in_memory().unwrap());
    let repos =
        Arc::new(RepoManager::new(Arc::new(git), store.clone(), sink.clone()).without_watcher());
    let id = repos.open(&fx.repo_str()).unwrap().id;
    Env {
        fx,
        sink,
        repos,
        store,
        global,
        id,
    }
}

fn value(list: &[yaggui_lib::git::ops::config::ConfigEntry], key: &str) -> Option<String> {
    list.iter()
        .find(|e| e.key == key)
        .and_then(|e| e.value.clone())
}

#[test]
fn a_missing_global_file_is_an_empty_configuration() {
    let e = env();
    assert!(!e.global.exists());
    assert!(
        e.repos
            .git_config_list(None, ConfigScope::Global)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn global_writes_land_in_the_global_file_without_a_repository() {
    let e = env();
    e.repos
        .git_config_set(
            None,
            ConfigScope::Global,
            "user.name".into(),
            Some("Ada".into()),
        )
        .unwrap();
    e.repos
        .git_config_set(
            None,
            ConfigScope::Global,
            "pull.rebase".into(),
            Some("true".into()),
        )
        .unwrap();
    let text = std::fs::read_to_string(&e.global).unwrap();
    assert!(text.contains("name = Ada"), "{text}");
    let list = e.repos.git_config_list(None, ConfigScope::Global).unwrap();
    assert_eq!(value(&list, "user.name").as_deref(), Some("Ada"));
    assert_eq!(value(&list, "pull.rebase").as_deref(), Some("true"));
    // The repository file is untouched.
    let local = e
        .repos
        .git_config_list(Some(e.id), ConfigScope::Repo)
        .unwrap();
    assert_eq!(value(&local, "user.name"), None);
    // The write went through an operation of kind `Config`, outside any repository.
    assert!(e.sink.events().iter().any(|ev| matches!(
        ev,
        BackendEvent::OpFinished(f) if f.kind == OpKind::Config
            && f.repo_id == 0
            && matches!(f.outcome, OpOutcome::Success { .. })
    )));
}

#[test]
fn local_writes_land_in_the_repository_file() {
    let e = env();
    e.repos
        .git_config_set(
            Some(e.id),
            ConfigScope::Repo,
            "core.autocrlf".into(),
            Some("input".into()),
        )
        .unwrap();
    let text = std::fs::read_to_string(e.fx.repo().join(".git/config")).unwrap();
    assert!(text.contains("autocrlf = input"), "{text}");
    assert!(!e.global.exists());
    let local = e
        .repos
        .git_config_list(Some(e.id), ConfigScope::Repo)
        .unwrap();
    assert_eq!(value(&local, "core.autocrlf").as_deref(), Some("input"));
    assert!(e.sink.events().iter().any(|ev| matches!(
        ev,
        BackendEvent::OpFinished(f) if f.kind == OpKind::Config && f.repo_id == e.id
    )));
}

#[test]
fn a_value_that_looks_like_an_option_is_stored_as_is() {
    let e = env();
    e.repos
        .git_config_set(
            None,
            ConfigScope::Global,
            "alias.x".into(),
            Some("--version".into()),
        )
        .unwrap();
    let list = e.repos.git_config_list(None, ConfigScope::Global).unwrap();
    assert_eq!(value(&list, "alias.x").as_deref(), Some("--version"));
}

#[test]
fn removing_a_key_removes_every_value_and_a_missing_key_is_fine() {
    let e = env();
    e.fx.git(&[
        "config",
        "--add",
        "remote.origin.fetch",
        "+refs/heads/*:refs/remotes/origin/*",
    ]);
    e.fx.git(&[
        "config",
        "--add",
        "remote.origin.fetch",
        "+refs/tags/*:refs/tags/*",
    ]);
    let local = e
        .repos
        .git_config_list(Some(e.id), ConfigScope::Repo)
        .unwrap();
    assert!(
        local
            .iter()
            .filter(|e| e.key == "remote.origin.fetch")
            .count()
            >= 2
    );
    e.repos
        .git_config_set(
            Some(e.id),
            ConfigScope::Repo,
            "remote.origin.fetch".into(),
            None,
        )
        .unwrap();
    let local = e
        .repos
        .git_config_list(Some(e.id), ConfigScope::Repo)
        .unwrap();
    assert!(local.iter().all(|e| e.key != "remote.origin.fetch"));
    e.repos
        .git_config_set(Some(e.id), ConfigScope::Repo, "never.set".into(), None)
        .unwrap();
}

#[test]
fn invalid_keys_values_and_scopes_are_refused_before_git_runs() {
    let e = env();
    for key in ["", "nodot", "-c.x", "user.na me", "a.1"] {
        let err = e
            .repos
            .git_config_set(None, ConfigScope::Global, key.into(), Some("x".into()))
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidArgument, "{key}");
    }
    let err = e
        .repos
        .git_config_set(None, ConfigScope::Global, "a.b".into(), Some("x\0y".into()))
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    // The repository scope needs a repository.
    let err = e
        .repos
        .git_config_set(None, ConfigScope::Repo, "a.b".into(), Some("x".into()))
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    assert!(e.repos.git_config_list(None, ConfigScope::Repo).is_err());
    assert!(!e.global.exists());
}

#[test]
fn the_identity_set_by_the_editor_is_what_commit_uses() {
    let e = env();
    e.repos
        .git_config_set(
            None,
            ConfigScope::Global,
            "user.name".into(),
            Some("Grace".into()),
        )
        .unwrap();
    e.repos
        .git_config_set(
            None,
            ConfigScope::Global,
            "user.email".into(),
            Some("grace@example.com".into()),
        )
        .unwrap();
    let identity = e.repos.git_identity(e.id).unwrap();
    assert_eq!(identity.name.as_deref(), Some("Grace"));
    assert_eq!(identity.email.as_deref(), Some("grace@example.com"));
}

#[test]
fn diff_and_merge_tools_are_looked_up_in_git() {
    let e = env();
    // A custom tool is known as soon as its command is configured.
    e.repos
        .git_config_set(
            None,
            ConfigScope::Global,
            "difftool.mine.cmd".into(),
            Some("true".into()),
        )
        .unwrap();
    let ok = e
        .repos
        .check_external_tool(ExternalToolKind::DiffTool, Some("mine".into()), None)
        .unwrap();
    assert!(ok.ok, "{ok:?}");
    assert_eq!(ok.tool, "mine");

    let missing = e
        .repos
        .check_external_tool(ExternalToolKind::DiffTool, Some("kdiff3".into()), None)
        .unwrap();
    // Installed on this machine or not, the answer is never "unknown".
    assert_ne!(missing.issue, Some(ToolIssue::Unknown), "{missing:?}");

    let unknown = e
        .repos
        .check_external_tool(
            ExternalToolKind::MergeTool,
            Some("yaggui-no-such-tool".into()),
            Some(e.id),
        )
        .unwrap();
    assert!(!unknown.ok);
    assert_eq!(unknown.issue, Some(ToolIssue::Unknown));

    // Without a name, the tool of the configuration is tested.
    let none = e
        .repos
        .check_external_tool(ExternalToolKind::MergeTool, None, Some(e.id))
        .unwrap();
    assert!(!none.ok);
    assert_eq!(none.issue, Some(ToolIssue::NotConfigured));
    e.repos
        .git_config_set(
            Some(e.id),
            ConfigScope::Repo,
            "merge.tool".into(),
            Some("mine".into()),
        )
        .unwrap();
    e.repos
        .git_config_set(
            Some(e.id),
            ConfigScope::Repo,
            "mergetool.mine.cmd".into(),
            Some("true".into()),
        )
        .unwrap();
    let configured = e
        .repos
        .check_external_tool(ExternalToolKind::MergeTool, None, Some(e.id))
        .unwrap();
    assert!(configured.ok, "{configured:?}");

    // A diff tool falls back to `diff.guitool`, like launching it does.
    e.repos
        .git_config_set(
            Some(e.id),
            ConfigScope::Repo,
            "diff.guitool".into(),
            Some("mine".into()),
        )
        .unwrap();
    let gui = e
        .repos
        .check_external_tool(ExternalToolKind::DiffTool, None, Some(e.id))
        .unwrap();
    assert!(gui.ok, "{gui:?}");
    assert_eq!(gui.tool, "mine");

    let err = e
        .repos
        .check_external_tool(ExternalToolKind::DiffTool, Some("--evil".into()), None)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
}

#[test]
fn the_merge_tool_of_the_preferences_wins_over_merge_tool() {
    let e = env();
    e.fx.git(&["config", "merge.tool", "vimdiff"]);
    assert_eq!(
        e.repos.merge_tool(e.id).unwrap().as_deref(),
        Some("vimdiff")
    );
    let mut prefs = e.store.preferences().unwrap();
    prefs.merge_tool = Some("meld".into());
    e.store.set_preferences(&prefs).unwrap();
    assert_eq!(e.repos.merge_tool(e.id).unwrap().as_deref(), Some("meld"));
}

#[test]
fn a_missing_editor_is_a_typed_error() {
    let e = env();
    let err = e
        .repos
        .check_external_tool(
            ExternalToolKind::Editor,
            Some("yaggui-no-such-editor".into()),
            None,
        )
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::EditorNotFound);
}

#[test]
fn the_editor_target_stays_inside_the_worktree() {
    let e = env();
    assert_eq!(e.repos.editor_target(e.id, None).unwrap(), e.fx.repo());
    assert_eq!(
        e.repos
            .editor_target(e.id, Some("src/a.txt".into()))
            .unwrap(),
        e.fx.repo().join("src/a.txt")
    );
    assert!(e.repos.editor_target(e.id, Some("../x".into())).is_err());
}
