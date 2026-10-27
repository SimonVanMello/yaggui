//! The bisect in progress (F-263), read from what `git bisect` keeps in `.git`: the marks as
//! `refs/bisect/<bad term>`, `refs/bisect/<good term>-<sha>` and `refs/bisect/skip-<sha>`,
//! the terms in `BISECT_TERMS` (`bad` / `good` unless started with `--term-new/--term-old`),
//! the HEAD to go back to in `BISECT_START` and, for `git bisect start --first-parent`
//! (Git ≥ 2.29), an empty `BISECT_FIRST_PARENT`. Nothing is kept by yaggui itself, so a bisect
//! started in a terminal, or interrupted by closing the app, reads back the same.
//!
//! The commits left are those reachable from the bad commit and from no good one (what
//! `git rev-list --bisect-vars` counts), only along first parents in first-parent mode (the
//! good side still hides every ancestor), walked with `gix`; the estimate of the steps left is
//! Git's own (`estimate_bisect_steps`).

use std::collections::BTreeSet;
use std::path::Path;

use gix::ObjectId;
use gix::bstr::ByteSlice;

use crate::git::errors::YagguiError;
use crate::git::ops::types::{BisectCommit, BisectResult, BisectState};
use crate::git::read::state::{RepoOperation, gix, read_operation};

/// The words `git bisect` takes for the two marks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Terms {
    pub bad: String,
    pub good: String,
}

impl Default for Terms {
    fn default() -> Self {
        Self {
            bad: "bad".to_owned(),
            good: "good".to_owned(),
        }
    }
}

/// `BISECT_TERMS`: the bad term, then the good one, one per line.
pub fn terms(git_dir: &Path) -> Terms {
    let Ok(text) = std::fs::read_to_string(git_dir.join("BISECT_TERMS")) else {
        return Terms::default();
    };
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    match (lines.next(), lines.next()) {
        (Some(bad), Some(good)) => Terms {
            bad: bad.to_owned(),
            good: good.to_owned(),
        },
        _ => Terms::default(),
    }
}

/// Git's estimate of the steps left with `all` commits to bisect (`estimate_bisect_steps` in
/// `bisect.c`): about log2, rounded down unless the extra commits are a third of a power of 2.
pub fn estimate_steps(all: u32) -> u32 {
    if all < 3 {
        return 0;
    }
    let n = 31 - all.leading_zeros();
    let e = 1u32 << n;
    let x = all - e;
    if u64::from(e) < 3 * u64::from(x) {
        n
    } else {
        n - 1
    }
}

struct Marks {
    bad: Option<ObjectId>,
    good: Vec<ObjectId>,
    skipped: Vec<ObjectId>,
}

fn read_marks(repo: &gix::Repository, terms: &Terms) -> Result<Marks, YagguiError> {
    let mut marks = Marks {
        bad: None,
        good: Vec::new(),
        skipped: Vec::new(),
    };
    let refs = repo.references().map_err(gix("read the bisect refs"))?;
    let iter = refs
        .prefixed("refs/bisect/")
        .map_err(gix("read the bisect refs"))?;
    let good_prefix = format!("{}-", terms.good);
    for reference in iter {
        let Ok(mut reference) = reference else {
            continue;
        };
        let full = reference.name().as_bstr().to_str_lossy().into_owned();
        let Some(name) = full.strip_prefix("refs/bisect/") else {
            continue;
        };
        let Ok(id) = reference.peel_to_id() else {
            continue;
        };
        let id = id.detach();
        if name == terms.bad {
            marks.bad = Some(id);
        } else if name.starts_with(&good_prefix) {
            marks.good.push(id);
        } else if name.starts_with("skip-") {
            marks.skipped.push(id);
        }
    }
    Ok(marks)
}

fn read_oid(git_dir: &Path, name: &str) -> Option<ObjectId> {
    let text = std::fs::read_to_string(git_dir.join(name)).ok()?;
    ObjectId::from_hex(text.trim().as_bytes()).ok()
}

pub fn bisect_commit(repo: &gix::Repository, id: ObjectId) -> Option<BisectCommit> {
    let commit = repo.find_commit(id).ok()?;
    let summary = commit
        .message_raw_sloppy()
        .lines()
        .next()
        .map(|l| l.to_str_lossy().trim_end().to_owned())
        .unwrap_or_default();
    let author = commit.author().ok()?;
    let author_time = author.seconds() as f64;
    Some(BisectCommit {
        sha: id.to_string(),
        summary,
        author_name: author.name.to_str_lossy().into_owned(),
        author_time,
    })
}

/// Commits reachable from `bad` and from none of `good`; with `first_parent`, only those of
/// the first-parent chain of `bad` (`git rev-list --first-parent`, whose hidden side still
/// follows every parent).
fn range(
    repo: &gix::Repository,
    bad: ObjectId,
    good: &[ObjectId],
    first_parent: bool,
) -> Result<Vec<ObjectId>, YagguiError> {
    let walk = repo
        .rev_walk([bad])
        .with_hidden(good.iter().copied())
        .all()
        .map_err(gix("walk the bisect range"))?;
    let mut out = Vec::new();
    for info in walk {
        out.push(info.map_err(gix("walk the bisect range"))?.id);
    }
    if !first_parent {
        return Ok(out);
    }
    // An ancestor of a hidden commit is hidden: the chain stops at the first one.
    let all: BTreeSet<ObjectId> = out.into_iter().collect();
    let mut chain = Vec::new();
    let mut current = Some(bad);
    while let Some(id) = current.filter(|id| all.contains(id)) {
        chain.push(id);
        let commit = repo.find_commit(id).map_err(gix("read a commit"))?;
        current = commit.parent_ids().next().map(gix::Id::detach);
    }
    Ok(chain)
}

/// The bisect was started with `--first-parent`.
pub fn is_first_parent(git_dir: &Path) -> bool {
    git_dir.join("BISECT_FIRST_PARENT").exists()
}

/// Newest first, by commit time.
fn by_time(repo: &gix::Repository, ids: &[ObjectId]) -> Vec<BisectCommit> {
    let mut commits: Vec<_> = ids
        .iter()
        .filter_map(|&id| bisect_commit(repo, id))
        .collect();
    commits.sort_by(|a, b| b.author_time.total_cmp(&a.author_time));
    commits
}

/// The bisect in progress, `None` when there is none.
pub fn read_bisect(repo: &gix::Repository) -> Result<Option<BisectState>, YagguiError> {
    if read_operation(repo) != Some(RepoOperation::Bisect) {
        return Ok(None);
    }
    let git_dir = repo.path();
    let terms = terms(git_dir);
    let first_parent = is_first_parent(git_dir);
    let marks = read_marks(repo, &terms)?;
    // `--no-checkout` bisects move `BISECT_HEAD` instead of HEAD.
    let current_id =
        read_oid(git_dir, "BISECT_HEAD").or_else(|| repo.head_id().ok().map(gix::Id::detach));
    let original = std::fs::read_to_string(git_dir.join("BISECT_START"))
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());

    let mut remaining = None;
    let mut steps = None;
    let mut result = None;
    if let (Some(bad), false) = (marks.bad, marks.good.is_empty()) {
        let range = range(repo, bad, &marks.good, first_parent)?;
        let skipped: BTreeSet<ObjectId> = marks.skipped.iter().copied().collect();
        let untested: Vec<ObjectId> = range
            .iter()
            .copied()
            .filter(|id| *id != bad && !skipped.contains(id))
            .collect();
        if !range.contains(&bad) {
            // Hidden by a good commit it is an ancestor of: an empty range is not a result.
            result = Some(BisectResult::InconsistentMarks);
        } else if untested.is_empty() {
            result = if range.len() == 1 {
                bisect_commit(repo, bad).map(|commit| BisectResult::Found { commit })
            } else {
                Some(BisectResult::Inconclusive {
                    candidates: by_time(repo, &range),
                })
            };
        }
        let left = u32::try_from(untested.len()).unwrap_or(u32::MAX);
        remaining = Some(left);
        steps = Some(estimate_steps(left.saturating_add(1)));
    }

    let marked = |id: ObjectId| {
        marks.bad == Some(id) || marks.good.contains(&id) || marks.skipped.contains(&id)
    };
    let awaiting_checkout = remaining.is_some_and(|left| left > 0)
        && result.is_none()
        && current_id.is_some_and(marked);
    let hex = |ids: &[ObjectId]| ids.iter().map(ToString::to_string).collect();
    Ok(Some(BisectState {
        bad: marks.bad.map(|id| id.to_string()),
        good: hex(&marks.good),
        skipped: hex(&marks.skipped),
        current: current_id.and_then(|id| bisect_commit(repo, id)),
        awaiting_checkout,
        remaining,
        steps,
        result,
        original,
        first_parent,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimates_steps_like_git() {
        // Values of `git bisect` ("roughly N steps") for these candidate counts.
        let cases = [
            (0, 0),
            (1, 0),
            (2, 0),
            (3, 1),
            (4, 1),
            (5, 1),
            (6, 2),
            (8, 2),
            (11, 3),
            (16, 3),
            (100, 6),
            (1024, 9),
        ];
        for (all, steps) in cases {
            assert_eq!(estimate_steps(all), steps, "all = {all}");
        }
    }

    #[test]
    fn reads_custom_terms() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(terms(dir.path()), Terms::default());
        std::fs::write(dir.path().join("BISECT_TERMS"), "new\nold\n").unwrap();
        assert_eq!(
            terms(dir.path()),
            Terms {
                bad: "new".to_owned(),
                good: "old".to_owned()
            }
        );
    }
}
