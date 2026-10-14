//! Background `git commit-graph write`: without the file, every graph load decodes the whole
//! history from the object database (10× slower on large repositories).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::git::cli::{CancelToken, GitCli, GitCommand};
use crate::git::errors::{ErrorCode, YagguiError};

/// Commits missing from the commit-graph below which writing it is not worth a full rewrite:
/// decoding them costs a few milliseconds per load.
pub const MIN_MISSING_COMMITS: usize = 1000;

/// Whether the commit-graph should be (re)written, given how many reachable commits it misses.
/// Repositories where Git would not use the file (disabled, shallow) are left alone.
pub fn is_worth_writing(repo: &gix::Repository, missing: usize) -> bool {
    if missing < MIN_MISSING_COMMITS || repo.is_shallow().unwrap_or(true) {
        return false;
    }
    repo.config_snapshot().boolean("core.commitGraph") != Some(false)
}

/// Rewrites the commit-graph for every reachable commit, with changed-path Bloom filters
/// (path-limited history). Git writes a temporary file and renames it, so a cancellation
/// keeps the previous file; the process is killed though, so the lock and temporary files it
/// left are removed (they would make every later `git commit-graph write` and `git gc` fail).
pub fn write(
    git: &GitCli,
    workdir: &Path,
    objects_dir: &Path,
    repo_id: u32,
    cancel: &CancelToken,
) -> Result<(), YagguiError> {
    let before = leftovers(objects_dir);
    let command = GitCommand::new([
        "commit-graph",
        "write",
        "--reachable",
        "--changed-paths",
        "--no-progress",
    ])
    .cwd(workdir)
    .repo(repo_id);
    let result = git.run_with(&command, Some(cancel), None).map(|_| ());
    if let Err(err) = &result
        && err.code == ErrorCode::Cancelled
    {
        for path in leftovers(objects_dir).difference(&before) {
            match std::fs::remove_file(path) {
                Ok(()) => tracing::info!(path = %path.display(), "removed after cancellation"),
                Err(err) => tracing::warn!(path = %path.display(), error = %err, "not removed"),
            }
        }
    }
    result
}

/// Lock and temporary files of a commit-graph write (`commit-graph.lock`, `tmp_graph_*`, and
/// the same in `commit-graphs/`).
fn leftovers(objects_dir: &Path) -> HashSet<PathBuf> {
    let info = objects_dir.join("info");
    [info.clone(), info.join("commit-graphs")]
        .iter()
        .filter_map(|dir| std::fs::read_dir(dir).ok())
        .flat_map(|entries| entries.flatten())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name().is_some_and(|name| {
                let name = name.to_string_lossy();
                name.ends_with(".lock") || name.starts_with("tmp_graph_")
            })
        })
        .collect()
}
