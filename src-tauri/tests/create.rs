//! Clone, init and preferences against real Git and local remotes (no network).
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use yaggui_lib::events::BackendEvent;
use yaggui_lib::git::cli::{DEFAULT_GIT, GitCli};
use yaggui_lib::git::errors::ErrorCode;
use yaggui_lib::git::log::CommandLog;
use yaggui_lib::git::ops::gitignore::GitignoreTemplate;
use yaggui_lib::repo::create::{CloneRequest, InitRequest, RepoCreator};
use yaggui_lib::state::save_preferences;
use yaggui_lib::store::{Preferences, Store};

mod common;
use common::RecordingSink;

fn isolate(command: &mut Command) -> &mut Command {
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_AUTHOR_NAME", "yaggui Tests")
        .env("GIT_AUTHOR_EMAIL", "tests@yaggui.dev")
        .env("GIT_COMMITTER_NAME", "yaggui Tests")
        .env("GIT_COMMITTER_EMAIL", "tests@yaggui.dev")
        // Submodules over file:// are refused by default since Git 2.38.1.
        .env("GIT_CONFIG_COUNT", "2")
        .env("GIT_CONFIG_KEY_0", "protocol.file.allow")
        .env("GIT_CONFIG_VALUE_0", "always")
        .env("GIT_CONFIG_KEY_1", "init.defaultBranch")
        .env("GIT_CONFIG_VALUE_1", "main")
}

fn git(dir: &Path, args: &[&str]) -> String {
    let mut command = Command::new("git");
    isolate(command.args(args).current_dir(dir));
    let out = command.output().expect("run git");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn commit_file(repo: &Path, name: &str, content: &str) {
    std::fs::write(repo.join(name), content).unwrap();
    git(repo, &["add", "--", name]);
    git(repo, &["commit", "-q", "-m", &format!("add {name}")]);
}

/// A bare remote with `main` (3 commits, a submodule `lib`) and `feature` (1 more commit).
struct Remote {
    root: tempfile::TempDir,
}

impl Remote {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        let lib = base.join("lib-src");
        std::fs::create_dir(&lib).unwrap();
        git(&lib, &["init", "-q"]);
        commit_file(&lib, "lib.txt", "library\n");

        let work = base.join("work");
        std::fs::create_dir(&work).unwrap();
        git(&work, &["init", "-q"]);
        commit_file(&work, "one.txt", "1\n");
        commit_file(&work, "two.txt", "2\n");
        git(
            &work,
            &[
                "submodule",
                "add",
                "-q",
                &format!("file://{}", lib.display()),
                "lib",
            ],
        );
        git(&work, &["commit", "-q", "-m", "add submodule"]);
        git(&work, &["checkout", "-q", "-b", "feature"]);
        commit_file(&work, "feature.txt", "f\n");
        git(&work, &["checkout", "-q", "main"]);
        git(
            base,
            &[
                "clone",
                "-q",
                "--bare",
                work.to_str().unwrap(),
                "remote.git",
            ],
        );
        Self { root }
    }

    fn url(&self) -> String {
        format!("file://{}", self.root.path().join("remote.git").display())
    }
}

struct Env {
    creator: Arc<RepoCreator>,
    sink: Arc<RecordingSink>,
    store: Arc<Store>,
    git: Arc<GitCli>,
    work: tempfile::TempDir,
}

fn env() -> Env {
    let sink = Arc::new(RecordingSink::default());
    let mut cli = GitCli::new(Arc::new(CommandLog::new()), sink.clone());
    for (name, value) in [
        ("GIT_CONFIG_NOSYSTEM", "1"),
        (
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        ),
        ("GIT_CONFIG_COUNT", "2"),
        ("GIT_CONFIG_KEY_0", "protocol.file.allow"),
        ("GIT_CONFIG_VALUE_0", "always"),
        ("GIT_CONFIG_KEY_1", "init.defaultBranch"),
        ("GIT_CONFIG_VALUE_1", "main"),
    ] {
        cli = cli.with_env(name, value);
    }
    let git = Arc::new(cli);
    let store = Arc::new(Store::open_in_memory().unwrap());
    let creator = Arc::new(RepoCreator::new(git.clone(), store.clone(), sink.clone()));
    Env {
        creator,
        sink,
        store,
        git,
        work: tempfile::tempdir().unwrap(),
    }
}

fn request(env: &Env, remote: &str, name: &str) -> CloneRequest {
    CloneRequest {
        clone_id: format!("clone-{name}"),
        url: remote.to_owned(),
        target: env.work.path().join(name).display().to_string(),
        branch: None,
        depth: None,
        recurse_submodules: false,
    }
}

#[test]
fn clones_the_default_branch_with_progress() {
    let remote = Remote::new();
    let env = env();
    let result = env
        .creator
        .clone_repo(&request(&env, &remote.url(), "plain"))
        .unwrap();
    let repo = PathBuf::from(&result.path);
    assert_eq!(git(&repo, &["symbolic-ref", "--short", "HEAD"]), "main");
    assert!(repo.join("two.txt").is_file());
    assert!(!repo.join("feature.txt").exists());
    // Without `--recurse-submodules` the submodule folder is left empty.
    assert!(!repo.join("lib/lib.txt").exists());

    let progress = env
        .sink
        .events()
        .into_iter()
        .filter_map(|e| match e {
            BackendEvent::CloneProgress(p) => Some(p),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert!(!progress.is_empty(), "no progress reported");
    assert!(progress.iter().all(|p| p.clone_id == "clone-plain"));
    assert!(progress.iter().any(|p| p.phase == "Receiving objects"));
    // The command is in the journal, like every Git command.
    assert!(
        env.git
            .log()
            .entries()
            .iter()
            .any(|e| e.args.iter().any(|a| a == "clone"))
    );
}

#[test]
fn clones_a_given_branch() {
    let remote = Remote::new();
    let env = env();
    let mut req = request(&env, &remote.url(), "feature");
    req.branch = Some("feature".into());
    let repo = PathBuf::from(env.creator.clone_repo(&req).unwrap().path);
    assert_eq!(git(&repo, &["symbolic-ref", "--short", "HEAD"]), "feature");
    assert!(repo.join("feature.txt").is_file());
}

#[test]
fn an_unknown_branch_is_reported_and_leaves_nothing() {
    let remote = Remote::new();
    let env = env();
    let mut req = request(&env, &remote.url(), "nobranch");
    req.branch = Some("does-not-exist".into());
    let err = env.creator.clone_repo(&req).unwrap_err();
    assert_eq!(err.code, ErrorCode::RemoteBranchNotFound);
    assert!(!Path::new(&req.target).exists());
}

#[test]
fn shallow_clone_keeps_the_requested_depth() {
    let remote = Remote::new();
    let env = env();
    let mut req = request(&env, &remote.url(), "shallow");
    req.depth = Some(1);
    let repo = PathBuf::from(env.creator.clone_repo(&req).unwrap().path);
    assert_eq!(git(&repo, &["rev-list", "--count", "HEAD"]), "1");
    assert!(repo.join(".git/shallow").is_file());
}

#[test]
fn recursive_clone_fetches_submodules() {
    let remote = Remote::new();
    let env = env();
    let mut req = request(&env, &remote.url(), "recursive");
    req.recurse_submodules = true;
    let repo = PathBuf::from(env.creator.clone_repo(&req).unwrap().path);
    assert!(repo.join("lib/lib.txt").is_file());
}

#[test]
fn refuses_a_non_empty_folder_and_does_not_touch_it() {
    let remote = Remote::new();
    let env = env();
    let target = env.work.path().join("busy");
    std::fs::create_dir(&target).unwrap();
    std::fs::write(target.join("mine.txt"), "keep").unwrap();
    let mut req = request(&env, &remote.url(), "busy");
    req.target = target.display().to_string();
    let err = env.creator.clone_repo(&req).unwrap_err();
    assert_eq!(err.code, ErrorCode::TargetNotEmpty);
    assert_eq!(
        std::fs::read_to_string(target.join("mine.txt")).unwrap(),
        "keep"
    );
}

#[test]
fn clones_into_an_existing_empty_folder() {
    let remote = Remote::new();
    let env = env();
    let target = env.work.path().join("empty");
    std::fs::create_dir(&target).unwrap();
    let mut req = request(&env, &remote.url(), "empty");
    req.target = target.display().to_string();
    env.creator.clone_repo(&req).unwrap();
    assert!(target.join("one.txt").is_file());
}

#[test]
fn rejects_dangerous_or_malformed_requests() {
    let env = env();
    let code = |mutate: &dyn Fn(&mut CloneRequest)| {
        let mut req = request(&env, "file:///nowhere", "bad");
        mutate(&mut req);
        env.creator.clone_repo(&req).unwrap_err().code
    };
    assert_eq!(
        code(&|r| r.url = "--upload-pack=touch /tmp/x".into()),
        ErrorCode::InvalidArgument
    );
    assert_eq!(code(&|r| r.url = " ".into()), ErrorCode::InvalidArgument);
    assert_eq!(
        code(&|r| r.target = "relative/dir".into()),
        ErrorCode::InvalidArgument
    );
    assert_eq!(code(&|r| r.depth = Some(0)), ErrorCode::InvalidArgument);
    assert_eq!(
        code(&|r| r.branch = Some("-x".into())),
        ErrorCode::InvalidRefName
    );
    assert_eq!(
        code(&|r| r.branch = Some("a b".into())),
        ErrorCode::InvalidRefName
    );
    // The ext:: transport runs a command: refused by `protocol.ext.allow=never`.
    let marker = env.work.path().join("pwned");
    let err = {
        let mut req = request(&env, &format!("ext::touch {}", marker.display()), "ext");
        req.target = env.work.path().join("ext").display().to_string();
        env.creator.clone_repo(&req).unwrap_err()
    };
    assert!(!marker.exists(), "ext:: transport ran a command");
    assert_ne!(err.code, ErrorCode::Cancelled);
}

#[test]
fn an_unreachable_host_is_translated_and_cleaned_up() {
    let env = env();
    // Nothing listens on port 1.
    let mut req = request(&env, "git://127.0.0.1:1/repo.git", "down");
    req.target = env.work.path().join("parent/down").display().to_string();
    let err = env.creator.clone_repo(&req).unwrap_err();
    assert_eq!(err.code, ErrorCode::HostUnreachable, "{err:?}");
    assert!(!env.work.path().join("parent").exists());
}

/// A server that accepts connections and never answers, so a clone stays running.
fn stalled_server() -> (
    String,
    std::thread::JoinHandle<()>,
    Arc<std::sync::atomic::AtomicBool>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!(
        "git://127.0.0.1:{}/repo.git",
        listener.local_addr().unwrap().port()
    );
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = stop.clone();
    let handle = std::thread::spawn(move || {
        let mut held = Vec::new();
        while !flag.load(std::sync::atomic::Ordering::SeqCst) {
            if let Ok((stream, _)) = listener.accept() {
                held.push(stream);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    });
    (url, handle, stop)
}

fn cancel_when_created(
    env: &Env,
    req: &CloneRequest,
    appears: &Path,
) -> yaggui_lib::git::errors::YagguiError {
    let creator = env.creator.clone();
    let id = req.clone_id.clone();
    let appears = appears.to_path_buf();
    let canceller = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !appears.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        // Let git reach the connection before stopping it.
        std::thread::sleep(Duration::from_millis(300));
        creator.cancel_clone(&id);
    });
    let err = env.creator.clone_repo(req).unwrap_err();
    canceller.join().unwrap();
    err
}

#[test]
fn cancelling_removes_the_folders_the_clone_created() {
    let env = env();
    let (url, server, stop) = stalled_server();
    let mut req = request(&env, &url, "slow");
    let target = env.work.path().join("made/by/clone");
    req.target = target.display().to_string();
    let err = cancel_when_created(&env, &req, &target);
    assert_eq!(err.code, ErrorCode::Cancelled);
    // The whole chain created for the clone is gone; the folder that was already there stays.
    assert!(!env.work.path().join("made").exists());
    assert!(env.work.path().exists());
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    server.join().unwrap();
}

#[test]
fn cancelling_keeps_a_pre_existing_folder_but_empties_it() {
    let env = env();
    let (url, server, stop) = stalled_server();
    let target = env.work.path().join("mine");
    std::fs::create_dir(&target).unwrap();
    let mut req = request(&env, &url, "slow-existing");
    req.target = target.display().to_string();
    let err = cancel_when_created(&env, &req, &target.join(".git"));
    assert_eq!(err.code, ErrorCode::Cancelled);
    assert!(target.is_dir(), "the user's folder must stay");
    assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    server.join().unwrap();
}

#[test]
fn cancelling_an_unknown_clone_is_harmless() {
    env().creator.cancel_clone("nothing-runs-under-this-id");
}

fn init_request(env: &Env, name: &str) -> InitRequest {
    InitRequest {
        target: env.work.path().join(name).display().to_string(),
        default_branch: "trunk".into(),
        gitignore: vec![GitignoreTemplate::Rust, GitignoreTemplate::MacOs],
        readme: true,
    }
}

#[test]
fn init_creates_the_repository_with_gitignore_and_readme() {
    let env = env();
    let req = init_request(&env, "fresh/project");
    let result = env.creator.init_repo(&req).unwrap();
    let repo = PathBuf::from(&result.path);
    assert_eq!(git(&repo, &["symbolic-ref", "HEAD"]), "refs/heads/trunk");
    let ignore = std::fs::read_to_string(repo.join(".gitignore")).unwrap();
    assert!(ignore.contains("# Rust\ntarget/\n"));
    assert!(ignore.contains("# macOS\n.DS_Store\n"));
    assert_eq!(
        std::fs::read_to_string(repo.join("README.md")).unwrap(),
        "# project\n"
    );
    assert_eq!(result.created_files, [".gitignore", "README.md"]);
    // No commit is made: the files appear in the staging area.
    assert!(git(&repo, &["status", "--porcelain"]).contains("?? .gitignore"));
}

#[test]
fn init_without_options_writes_no_file() {
    let env = env();
    let mut req = init_request(&env, "bare-init");
    req.gitignore.clear();
    req.readme = false;
    let result = env.creator.init_repo(&req).unwrap();
    assert!(result.created_files.is_empty());
    assert!(!Path::new(&result.path).join(".gitignore").exists());
}

#[test]
fn init_never_replaces_existing_files() {
    let env = env();
    let dir = env.work.path().join("existing");
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join(".gitignore"), "mine\n").unwrap();
    std::fs::write(dir.join("readme.txt"), "my readme").unwrap();
    let result = env
        .creator
        .init_repo(&init_request(&env, "existing"))
        .unwrap();
    assert!(result.created_files.is_empty());
    assert_eq!(
        std::fs::read_to_string(dir.join(".gitignore")).unwrap(),
        "mine\n"
    );
    assert!(!dir.join("README.md").exists());
}

#[test]
fn init_refuses_an_existing_repository_and_a_bad_branch() {
    let env = env();
    env.creator.init_repo(&init_request(&env, "twice")).unwrap();
    let err = env
        .creator
        .init_repo(&init_request(&env, "twice"))
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::AlreadyRepository);

    let mut bad = init_request(&env, "badbranch");
    bad.default_branch = "no good".into();
    assert_eq!(
        env.creator.init_repo(&bad).unwrap_err().code,
        ErrorCode::InvalidRefName
    );
    assert!(!env.work.path().join("badbranch").exists());
}

#[test]
fn defaults_follow_the_git_config_and_the_last_folder() {
    let env = env();
    let defaults = env.creator.defaults().unwrap();
    assert_eq!(defaults.default_branch, "main");
    assert_eq!(defaults.parent_dir, None);
    env.creator
        .init_repo(&init_request(&env, "remembered"))
        .unwrap();
    assert_eq!(
        env.creator.defaults().unwrap().parent_dir,
        Some(env.work.path().display().to_string())
    );
}

#[test]
fn an_invalid_git_path_is_refused_and_nothing_is_saved() {
    let env = env();
    let with_path = |path: &str| Preferences {
        git_path: Some(path.to_owned()),
        ..Preferences::default()
    };
    let missing = env.work.path().join("no-such-git");
    let err = save_preferences(
        &env.git,
        &env.store,
        with_path(&missing.display().to_string()),
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::GitBinaryInvalid);

    // A file that exists but is not Git.
    let fake = env.work.path().join("fake-git");
    std::fs::write(&fake, "not a program").unwrap();
    let err =
        save_preferences(&env.git, &env.store, with_path(&fake.display().to_string())).unwrap_err();
    assert_eq!(err.code, ErrorCode::GitBinaryInvalid);

    assert_eq!(env.store.preferences().unwrap().git_path, None);
    assert_eq!(env.git.binary(), PathBuf::from(DEFAULT_GIT));
}

#[test]
fn a_valid_git_path_is_stored_and_used_for_every_command() {
    let env = env();
    let found = yaggui_lib::system::git_binary::detect().expect("git on the PATH");
    let saved = save_preferences(
        &env.git,
        &env.store,
        Preferences {
            git_path: Some(found.display().to_string()),
            ..Preferences::default()
        },
    )
    .unwrap();
    assert_eq!(saved.git_path, Some(found.display().to_string()));
    assert_eq!(env.git.binary(), found);
    assert!(env.git.version().is_some());

    // Back to automatic detection.
    save_preferences(&env.git, &env.store, Preferences::default()).unwrap();
    assert_eq!(env.git.binary(), PathBuf::from(DEFAULT_GIT));
}

#[test]
fn probing_does_not_switch_the_binary() {
    let env = env();
    let found = yaggui_lib::system::git_binary::detect().expect("git on the PATH");
    let version = env.git.probe(&found).unwrap();
    assert!(version.starts_with(|c: char| c.is_ascii_digit()));
    assert_eq!(env.git.binary(), PathBuf::from(DEFAULT_GIT));
}

#[test]
fn a_saved_unrelated_preference_does_not_re_check_the_git_path() {
    let env = env();
    // The stored path vanished (Git uninstalled): changing the theme must still work.
    env.store
        .set_preferences(&Preferences {
            git_path: Some(env.work.path().join("gone").display().to_string()),
            ..Preferences::default()
        })
        .unwrap();
    let stored = env.store.preferences().unwrap();
    let saved = save_preferences(
        &env.git,
        &env.store,
        Preferences {
            theme: yaggui_lib::store::ThemePreference::Dark,
            ..stored
        },
    )
    .unwrap();
    assert_eq!(saved.theme, yaggui_lib::store::ThemePreference::Dark);
}
