//! Finds the `git` binary (F-322). Looking for a file is not running it: the version check
//! goes through `GitCli::probe`.

use std::path::{Path, PathBuf};

const GIT_FILE: &str = if cfg!(windows) { "git.exe" } else { "git" };

/// Where Git usually lives when the app was started with a short `PATH` (a macOS app launched
/// from the Dock does not see Homebrew).
const WELL_KNOWN: &[&str] = &[
    "/usr/bin/git",
    "/usr/local/bin/git",
    "/opt/homebrew/bin/git",
    r"C:\Program Files\Git\cmd\git.exe",
    r"C:\Program Files (x86)\Git\cmd\git.exe",
];

/// First `git` on the `PATH`, then in the usual install folders.
pub fn detect() -> Option<PathBuf> {
    let search = std::env::var_os("PATH").unwrap_or_default();
    find_in(
        std::env::split_paths(&search),
        WELL_KNOWN.iter().map(Path::new),
    )
}

fn find_in<'a>(
    path_dirs: impl IntoIterator<Item = PathBuf>,
    fallbacks: impl IntoIterator<Item = &'a Path>,
) -> Option<PathBuf> {
    path_dirs
        .into_iter()
        .map(|dir| dir.join(GIT_FILE))
        .chain(fallbacks.into_iter().map(Path::to_path_buf))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_the_path_over_the_fallbacks() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        std::fs::write(second.path().join(GIT_FILE), "").unwrap();
        let fallback = first.path().join("fallback-git");
        std::fs::write(&fallback, "").unwrap();
        let found = find_in(
            [first.path().to_path_buf(), second.path().to_path_buf()],
            [fallback.as_path()],
        );
        assert_eq!(found, Some(second.path().join(GIT_FILE)));
    }

    #[test]
    fn falls_back_when_the_path_has_no_git() {
        let empty = tempfile::tempdir().unwrap();
        let fallback = empty.path().join("fallback-git");
        std::fs::write(&fallback, "").unwrap();
        assert_eq!(
            find_in([empty.path().to_path_buf()], [fallback.as_path()]),
            Some(fallback)
        );
        assert_eq!(find_in([empty.path().to_path_buf()], []), None);
    }
}
