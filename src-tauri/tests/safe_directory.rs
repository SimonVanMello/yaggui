//! `add_safe_directory` writes the global Git config. Kept in its own test binary because
//! it redirects `GIT_CONFIG_GLOBAL` for the whole process.

mod common;

#[test]
fn adds_the_path_to_the_global_safe_directory_list() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("gitconfig");
    std::fs::write(&config, "").unwrap();
    // SAFETY: the only test of this binary, run before any other thread reads the environment.
    unsafe { std::env::set_var("GIT_CONFIG_GLOBAL", &config) };

    let b = common::backend(false);
    let repo = dir.path().join("some repo");
    // As Git reports it in its "dubious ownership" message, where the path comes from: with
    // `/` on Windows too (a `\` would be escaped in the file).
    let repo = repo.to_string_lossy().replace('\\', "/");
    b.repos.add_safe_directory(&repo).unwrap();

    let written = std::fs::read_to_string(&config).unwrap();
    assert!(written.contains("[safe]"), "{written}");
    assert!(
        written.contains(&format!("directory = {repo}")),
        "{written}"
    );
    assert_eq!(
        b.git.log().entries().last().unwrap().args,
        ["config", "--global", "--add", "safe.directory", &repo]
    );
    assert!(b.repos.add_safe_directory("relative").is_err());
}
