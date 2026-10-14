//! Git must act on the repository we point it to, whatever the inherited environment.
//! Own test binary: it changes process-wide environment variables.

mod common;

use yaggui_lib::git::cli::GitCommand;

#[test]
fn inherited_git_location_variables_are_ignored() {
    let fx = common::Fixture::new("clean");
    let elsewhere = tempfile::tempdir().unwrap();
    let bogus = elsewhere.path().join("not-a-git-dir");
    // SAFETY: the only test of this binary, set before any thread reads the environment.
    unsafe {
        std::env::set_var("GIT_DIR", &bogus);
        std::env::set_var("GIT_WORK_TREE", elsewhere.path());
        std::env::set_var("GIT_INDEX_FILE", bogus.join("index"));
        std::env::set_var("GIT_OBJECT_DIRECTORY", bogus.join("objects"));
        std::env::set_var("GIT_CONFIG_COUNT", "1");
        std::env::set_var("GIT_CONFIG_KEY_0", "core.bare");
        std::env::set_var("GIT_CONFIG_VALUE_0", "true");
    }

    let b = common::backend(false);
    let out = b
        .git
        .run(
            &GitCommand::new(["rev-parse", "--show-toplevel", "--is-bare-repository"])
                .cwd(fx.repo()),
        )
        .unwrap();
    let mut lines = out.stdout.lines();
    assert_eq!(lines.next(), Some(fx.repo_str().as_str()));
    assert_eq!(lines.next(), Some("false"));

    // A git write lands in the fixture, not in the inherited location.
    b.git
        .run(&GitCommand::new(["branch", "from-yaggui"]).cwd(fx.repo()))
        .unwrap();
    assert!(fx.repo().join(".git/refs/heads/from-yaggui").exists());
}
