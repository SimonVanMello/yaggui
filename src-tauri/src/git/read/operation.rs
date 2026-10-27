//! The operation in progress and its conflicts, read from `.git` and the index (M3-1).

use std::collections::BTreeMap;
use std::path::Path;

use gix::ObjectId;
use gix::bstr::ByteSlice;

use crate::git::errors::YagguiError;
use crate::git::ops::types::{
    CommitRef, ConflictFile, ConflictKind, ConflictLabels, ConflictList, ConflictSide,
    ConflictStage, ConflictVersions, OperationDetail, SideLabel,
};
use crate::git::read::image;
use crate::git::read::state::{RepoOperation, gix, read_operation};

/// Git's own binary heuristic: a NUL byte in the first 8000 bytes.
const BINARY_PROBE: usize = 8000;

/// Index stages of one conflicted path.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Stages {
    pub base: Option<ObjectId>,
    pub ours: Option<ObjectId>,
    pub theirs: Option<ObjectId>,
}

impl Stages {
    pub fn kind(&self) -> ConflictKind {
        match (
            self.base.is_some(),
            self.ours.is_some(),
            self.theirs.is_some(),
        ) {
            (true, true, true) => ConflictKind::Content,
            (false, true, true) => ConflictKind::BothAdded,
            (true, false, true) => ConflictKind::DeletedByUs,
            (true, true, false) => ConflictKind::DeletedByThem,
            (false, true, false) => ConflictKind::AddedByUs,
            (false, false, true) => ConflictKind::AddedByThem,
            _ => ConflictKind::BothDeleted,
        }
    }
}

/// Conflicted paths of the index and their stages, sorted by path.
pub fn conflict_stages(index: &gix::index::State) -> BTreeMap<String, Stages> {
    use gix::index::entry::Stage;

    let mut out: BTreeMap<String, Stages> = BTreeMap::new();
    for entry in index.entries() {
        let stage = entry.stage();
        if stage == Stage::Unconflicted {
            continue;
        }
        let path = entry.path(index).to_str_lossy().into_owned();
        let stages = out.entry(path).or_default();
        match stage {
            Stage::Base => stages.base = Some(entry.id),
            Stage::Ours => stages.ours = Some(entry.id),
            Stage::Theirs => stages.theirs = Some(entry.id),
            Stage::Unconflicted => {}
        }
    }
    out
}

fn read_index(repo: &gix::Repository) -> Result<gix::worktree::Index, YagguiError> {
    repo.index_or_empty().map_err(gix("read index"))
}

fn is_binary(data: &[u8]) -> bool {
    data[..data.len().min(BINARY_PROBE)].contains(&0)
}

fn blob(repo: &gix::Repository, id: ObjectId) -> Result<Vec<u8>, YagguiError> {
    Ok(repo
        .find_object(id)
        .map_err(gix("read a conflicted file"))?
        .detach()
        .data)
}

fn side(id: Option<ObjectId>, data: Vec<u8>) -> ConflictSide {
    let binary = is_binary(&data);
    ConflictSide {
        id: id.map(|id| id.to_string()),
        text: (!binary).then(|| String::from_utf8_lossy(&data).into_owned()),
        binary,
        size: u32::try_from(data.len()).unwrap_or(u32::MAX),
    }
}

fn read_git_file(git_dir: &Path, name: &str) -> Option<String> {
    std::fs::read_to_string(git_dir.join(name)).ok()
}

fn read_oid(git_dir: &Path, name: &str) -> Option<ObjectId> {
    let text = read_git_file(git_dir, name)?;
    ObjectId::from_hex(text.lines().next()?.trim().as_bytes()).ok()
}

/// Paths Git listed under `# Conflicts:` in the prepared message when the operation stopped
/// (merge, cherry-pick, revert, rebase step), whatever the comment character.
pub fn conflict_hint_paths(git_dir: &Path) -> Vec<String> {
    let Some(message) = read_git_file(git_dir, "MERGE_MSG") else {
        return Vec::new();
    };
    let mut lines = message.lines();
    let mut paths = Vec::new();
    // The message of the picked or reverted commit comes first: its lines may start with any
    // character, so skip the comment character by char, never by byte.
    for line in lines.by_ref() {
        let after_comment_char = line.char_indices().nth(1).map(|(i, _)| &line[i..]);
        if after_comment_char.is_some_and(|rest| rest.trim() == "Conflicts:") {
            break;
        }
    }
    for line in lines {
        let mut chars = line.chars();
        match (chars.next(), chars.next()) {
            (Some(_), Some('\t')) => paths.push(chars.as_str().to_owned()),
            _ => break,
        }
    }
    paths
}

fn comment_char(repo: &gix::Repository) -> char {
    repo.config_snapshot()
        .string("core.commentChar")
        .and_then(|value| value.to_str().ok()?.chars().next())
        .filter(|c| !c.is_whitespace())
        .unwrap_or('#')
}

/// A prepared message without its comment lines (and what follows a scissors line), the
/// way `git commit` cleans an edited message.
pub fn clean_message(message: &str, comment: char) -> String {
    let mut out = Vec::new();
    for line in message.lines() {
        if line.starts_with(comment) {
            if line.contains("------------------------ >8 ------------------------") {
                break;
            }
            continue;
        }
        out.push(line.trim_end());
    }
    while out.last().is_some_and(|l| l.is_empty()) {
        out.pop();
    }
    while out.first().is_some_and(|l| l.is_empty()) {
        out.remove(0);
    }
    out.join("\n")
}

/// The message Git prepared for the commit that continuing the operation makes.
pub fn prepared_message(repo: &gix::Repository, operation: &RepoOperation) -> Option<String> {
    let git_dir = repo.path();
    let raw = match operation {
        RepoOperation::Bisect | RepoOperation::ApplyMailbox => None,
        RepoOperation::Merge { squash: true } => read_git_file(git_dir, "SQUASH_MSG"),
        RepoOperation::Rebase { .. } => read_git_file(git_dir, "rebase-merge/message")
            .or_else(|| read_git_file(git_dir, "MERGE_MSG")),
        _ => read_git_file(git_dir, "MERGE_MSG"),
    }?;
    let cleaned = clean_message(&raw, comment_char(repo));
    (!cleaned.is_empty()).then_some(cleaned)
}

fn commit_ref(repo: &gix::Repository, id: ObjectId) -> Option<CommitRef> {
    let commit = repo.find_commit(id).ok()?;
    let summary = commit
        .message_raw_sloppy()
        .lines()
        .next()
        .map(|l| l.to_str_lossy().trim_end().to_owned())
        .unwrap_or_default();
    Some(CommitRef {
        sha: id.to_string(),
        summary,
    })
}

/// A branch pointing to `id`: local first, then remote-tracking; `None` when there is none.
fn branch_at(repo: &gix::Repository, id: ObjectId) -> Option<String> {
    let refs = repo.references().ok()?;
    let mut remote = None;
    for prefix in ["refs/heads/", "refs/remotes/"] {
        let Ok(iter) = refs.prefixed(prefix) else {
            continue;
        };
        for reference in iter.flatten() {
            let name = reference.name().shorten().to_string();
            if name.ends_with("/HEAD") {
                continue;
            }
            let mut reference = reference;
            if reference
                .peel_to_id()
                .is_ok_and(|target| target.detach() == id)
            {
                if prefix == "refs/heads/" {
                    return Some(name);
                }
                remote.get_or_insert(name);
            }
        }
    }
    remote
}

fn label(repo: &gix::Repository, branch: Option<String>, id: Option<ObjectId>) -> SideLabel {
    SideLabel {
        branch: branch.or_else(|| id.and_then(|id| branch_at(repo, id))),
        commit: id.and_then(|id| commit_ref(repo, id)),
    }
}

/// HEAD: its branch when one is checked out, and its commit.
fn head_label(repo: &gix::Repository) -> SideLabel {
    let branch = repo
        .head_name()
        .ok()
        .flatten()
        .map(|name| name.shorten().to_string());
    let id = repo.head_id().ok().map(gix::Id::detach);
    SideLabel {
        branch,
        commit: id.and_then(|id| commit_ref(repo, id)),
    }
}

/// The branch a merge message names: `Merge branch 'x'`, `Merge remote-tracking branch 'origin/x'`.
/// `None` for `Merge branch 'x' of <url>` (a pull): `x` is the remote's branch, not a local
/// one, so the label falls back to the ref at `MERGE_HEAD` (`origin/x` after the fetch).
fn merged_branch(git_dir: &Path) -> Option<String> {
    let message = read_git_file(git_dir, "MERGE_MSG")?;
    merged_branch_of(message.lines().next()?)
}

fn merged_branch_of(first_line: &str) -> Option<String> {
    let rest = first_line
        .strip_prefix("Merge branch '")
        .or_else(|| first_line.strip_prefix("Merge remote-tracking branch '"))?;
    let (branch, after) = rest.split_once('\'')?;
    (!after.starts_with(" of ")).then(|| branch.to_owned())
}

/// Who ours and theirs are for `operation` (see `ConflictLabels`).
pub fn labels(repo: &gix::Repository, operation: Option<&RepoOperation>) -> ConflictLabels {
    let git_dir = repo.path();
    let none = SideLabel {
        branch: None,
        commit: None,
    };
    match operation {
        Some(RepoOperation::Merge { squash: false }) => ConflictLabels {
            ours: head_label(repo),
            theirs: label(
                repo,
                merged_branch(git_dir),
                read_oid(git_dir, "MERGE_HEAD"),
            ),
        },
        Some(RepoOperation::Merge { squash: true }) => {
            // `Squashed commit of the following:` then `commit <sha>` of the newest one.
            let newest = read_git_file(git_dir, "SQUASH_MSG").and_then(|message| {
                message
                    .lines()
                    .find_map(|l| l.strip_prefix("commit "))
                    .and_then(|sha| ObjectId::from_hex(sha.trim().as_bytes()).ok())
            });
            ConflictLabels {
                ours: head_label(repo),
                theirs: label(repo, None, newest),
            }
        }
        Some(RepoOperation::Rebase { head_name, .. }) => {
            let dir = if git_dir.join("rebase-merge").is_dir() {
                "rebase-merge"
            } else {
                "rebase-apply"
            };
            let onto = read_oid(git_dir, &format!("{dir}/onto"));
            let replayed = read_oid(git_dir, "REBASE_HEAD")
                .or_else(|| read_oid(git_dir, &format!("{dir}/stopped-sha")));
            ConflictLabels {
                ours: label(repo, None, onto),
                theirs: SideLabel {
                    branch: head_name.clone(),
                    commit: replayed.and_then(|id| commit_ref(repo, id)),
                },
            }
        }
        Some(RepoOperation::CherryPick) => ConflictLabels {
            ours: head_label(repo),
            theirs: SideLabel {
                branch: None,
                commit: read_oid(git_dir, "CHERRY_PICK_HEAD").and_then(|id| commit_ref(repo, id)),
            },
        },
        Some(RepoOperation::Revert) => ConflictLabels {
            ours: head_label(repo),
            theirs: SideLabel {
                branch: None,
                commit: read_oid(git_dir, "REVERT_HEAD").and_then(|id| commit_ref(repo, id)),
            },
        },
        Some(RepoOperation::Bisect | RepoOperation::ApplyMailbox) | None => ConflictLabels {
            ours: head_label(repo),
            theirs: none,
        },
    }
}

/// Conflicted files, and while an operation is in progress the ones resolved since it
/// stopped (listed by Git in its prepared message).
pub fn read_conflicts(repo: &gix::Repository) -> Result<ConflictList, YagguiError> {
    let index = read_index(repo)?;
    let stages = conflict_stages(&index);
    let operation = read_operation(repo);
    let mut files: BTreeMap<String, ConflictFile> = BTreeMap::new();
    for (path, stage) in &stages {
        let mut binary = false;
        for id in [stage.base, stage.ours, stage.theirs].into_iter().flatten() {
            if is_binary(&blob(repo, id)?) {
                binary = true;
                break;
            }
        }
        files.insert(
            path.clone(),
            ConflictFile {
                path: path.clone(),
                kind: Some(stage.kind()),
                binary,
                resolved: false,
            },
        );
    }
    if operation.is_some() {
        for path in conflict_hint_paths(repo.path()) {
            files.entry(path.clone()).or_insert(ConflictFile {
                path,
                kind: None,
                binary: false,
                resolved: true,
            });
        }
    }
    let files: Vec<ConflictFile> = files.into_values().collect();
    let unresolved =
        u32::try_from(files.iter().filter(|f| !f.resolved).count()).unwrap_or(u32::MAX);
    Ok(ConflictList {
        files,
        unresolved,
        labels: labels(repo, operation.as_ref()),
    })
}

/// The three index versions of `path` and its working tree file.
pub fn read_versions(
    repo: &gix::Repository,
    workdir: &Path,
    path: &str,
) -> Result<ConflictVersions, YagguiError> {
    let index = read_index(repo)?;
    let stages = conflict_stages(&index).remove(path);
    let read = |id: Option<ObjectId>| -> Result<Option<ConflictSide>, YagguiError> {
        id.map(|id| Ok(side(Some(id), blob(repo, id)?))).transpose()
    };
    let full = workdir.join(path);
    let merged = match std::fs::symlink_metadata(&full) {
        Ok(meta) if meta.is_file() => Some(side(
            None,
            std::fs::read(&full).map_err(|err| {
                crate::git::errors::BackendError::io(format!("cannot read {}", full.display()), err)
            })?,
        )),
        _ => None,
    };
    let stages = stages.unwrap_or_default();
    let in_conflict = stages != Stages::default();
    Ok(ConflictVersions {
        path: path.to_owned(),
        kind: in_conflict.then(|| stages.kind()),
        base: read(stages.base)?,
        ours: read(stages.ours)?,
        theirs: read(stages.theirs)?,
        merged,
        labels: labels(repo, read_operation(repo).as_ref()),
    })
}

/// The operation in progress, `None` when there is none.
pub fn read_detail(repo: &gix::Repository) -> Result<Option<OperationDetail>, YagguiError> {
    let Some(operation) = read_operation(repo) else {
        return Ok(None);
    };
    let index = read_index(repo)?;
    let unresolved = u32::try_from(conflict_stages(&index).len()).unwrap_or(u32::MAX);
    let bisect = operation == RepoOperation::Bisect;
    Ok(Some(OperationDetail {
        message: prepared_message(repo, &operation),
        labels: labels(repo, Some(&operation)),
        unresolved,
        can_continue: unresolved == 0 && !bisect,
        can_skip: !matches!(operation, RepoOperation::Merge { .. }),
        operation,
    }))
}

/// External merge tool configured for the repository (`merge.tool`), if any.
pub fn merge_tool(repo: &gix::Repository) -> Option<String> {
    let config = repo.config_snapshot();
    let tool = config.string("merge.tool")?;
    let tool = tool.to_str_lossy().trim().to_owned();
    (!tool.is_empty()).then_some(tool)
}

/// One stage of a conflicted image as a `data:` URL (the CSP allows `img-src data:`);
/// `None` when the path is not an image, the stage is absent, or it is too large.
pub fn read_image(
    repo: &gix::Repository,
    path: &str,
    stage: ConflictStage,
) -> Result<Option<String>, YagguiError> {
    let Some(media) = image::media_type(path) else {
        return Ok(None);
    };
    let index = read_index(repo)?;
    let stages = conflict_stages(&index).remove(path).unwrap_or_default();
    let id = match stage {
        ConflictStage::Base => stages.base,
        ConflictStage::Ours => stages.ours,
        ConflictStage::Theirs => stages.theirs,
    };
    let Some(id) = id else { return Ok(None) };
    let data = blob(repo, id)?;
    Ok(image::data_url(media, &data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_prepared_messages() {
        let message = "Merge branch 'feat'\n\n# Conflicts:\n#\tsrc/a.rs\n";
        assert_eq!(clean_message(message, '#'), "Merge branch 'feat'");
        let scissors =
            "Fix\n\nBody\n# ------------------------ >8 ------------------------\ndiff\n";
        assert_eq!(clean_message(scissors, '#'), "Fix\n\nBody");
        assert_eq!(clean_message("; note\nKeep #1\n", ';'), "Keep #1");
    }

    #[test]
    fn names_conflict_kinds_from_stages() {
        let id = Some(ObjectId::null(gix::hash::Kind::Sha1));
        let stages = |base, ours, theirs| Stages { base, ours, theirs }.kind();
        assert_eq!(stages(id, id, id), ConflictKind::Content);
        assert_eq!(stages(None, id, id), ConflictKind::BothAdded);
        assert_eq!(stages(id, None, id), ConflictKind::DeletedByUs);
        assert_eq!(stages(id, id, None), ConflictKind::DeletedByThem);
        assert_eq!(stages(None, id, None), ConflictKind::AddedByUs);
        assert_eq!(stages(None, None, id), ConflictKind::AddedByThem);
        assert_eq!(stages(id, None, None), ConflictKind::BothDeleted);
    }

    #[test]
    fn reads_the_conflicts_hint() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("MERGE_MSG"),
            "Merge branch 'feat'\n\n; Conflicts:\n;\ta b.txt\n;\tsrc/c.rs\n",
        )
        .unwrap();
        assert_eq!(conflict_hint_paths(dir.path()), ["a b.txt", "src/c.rs"]);
    }

    #[test]
    fn conflicts_hint_survives_multi_byte_message_lines() {
        // A cherry-pick keeps the picked commit's message in MERGE_MSG: lines starting with a
        // multi-byte character must not be sliced at byte 1.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("MERGE_MSG"),
            "Évite un crash\n\n« détail » — suite 🚀\n😀\n\n# Conflicts:\n#\tsrc/é.rs\n",
        )
        .unwrap();
        assert_eq!(conflict_hint_paths(dir.path()), ["src/é.rs"]);
        std::fs::write(dir.path().join("MERGE_MSG"), "É\n—\n").unwrap();
        assert!(conflict_hint_paths(dir.path()).is_empty());
    }

    #[test]
    fn merge_message_names_a_local_branch_only() {
        assert_eq!(
            merged_branch_of("Merge branch 'feat'").as_deref(),
            Some("feat")
        );
        assert_eq!(
            merged_branch_of("Merge remote-tracking branch 'origin/x' into main").as_deref(),
            Some("origin/x")
        );
        assert_eq!(
            merged_branch_of("Merge branch 'main' of https://host/r.git"),
            None
        );
    }
}
