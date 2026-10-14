//! Refs listing for the sidebar (F-040 to F-045): branches, remotes, tags, stashes,
//! submodules and worktrees.

use std::hash::{Hash, Hasher};

use gix::ObjectId;
use gix::bstr::ByteSlice;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::git::errors::{BackendError, YagguiError};
use crate::git::read::ahead_behind;
use crate::git::read::state::{HeadState, UpstreamState, count_exclusive, gix, read_head};
use crate::graph::types::{RefKind, RefLabel};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranch {
    /// Short name, `feat/graph`.
    pub name: String,
    /// `refs/heads/feat/graph`.
    pub full_name: String,
    /// Commit the branch points to.
    pub sha: String,
    /// Checked out in this worktree.
    pub is_head: bool,
    pub upstream: Option<UpstreamState>,
    /// Row of `sha` in the graph of version `RepoRefs::graphVersion`, when known.
    pub row: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranch {
    /// Short name including the remote, `origin/main`.
    pub name: String,
    /// `refs/remotes/origin/main`.
    pub full_name: String,
    pub sha: String,
    pub row: Option<u32>,
}

/// A configured remote and its remote-tracking branches (symbolic `origin/HEAD` excluded).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRefs {
    pub name: String,
    /// Fetch URL, `None` for a remote without URL or branches left from a removed remote.
    pub url: Option<String>,
    /// `remote.<name>.pushurl` when set: pushes go there instead of `url`.
    pub push_url: Option<String>,
    pub branches: Vec<RemoteBranch>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TagRef {
    pub name: String,
    pub full_name: String,
    /// Commit the tag points to (peeled). For a tag on a tree or blob, that object's id.
    pub sha: String,
    pub annotated: bool,
    /// First line of the annotation message (annotated tags only).
    pub message: Option<String>,
    pub row: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashRef {
    /// 0 for the most recent stash.
    pub index: u32,
    /// `stash@{0}`.
    pub name: String,
    /// Stash message, e.g. `WIP on main: 3f9c2a1 fix: …`.
    pub message: String,
    /// The stash commit.
    pub sha: String,
    /// The commit the stash was made on (first parent of the stash commit).
    pub base_sha: String,
    /// Commit holding the untracked files (third parent, `--include-untracked`): diffing the
    /// stash against its base does not show them.
    pub untracked_sha: Option<String>,
    /// Row of `baseSha` in the graph, when known.
    pub row: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleRef {
    pub name: String,
    /// Path relative to the worktree root.
    pub path: String,
    pub url: Option<String>,
    /// Commit recorded in the index of the superproject, `None` if not recorded.
    pub sha: Option<String>,
    /// The submodule is checked out (has its own repository).
    pub initialized: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRef {
    /// Absolute path of the worktree.
    pub path: String,
    pub head: Option<HeadState>,
    /// The main worktree (the one holding the `.git` folder).
    pub is_main: bool,
    /// The worktree this session is showing.
    pub is_current: bool,
    pub locked: bool,
    /// The worktree folder no longer exists (`git worktree prune` would remove it).
    pub prunable: bool,
}

/// Everything shown in the refs sidebar, in display order (names sorted).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoRefs {
    /// Graph version the `row` fields refer to; `None` when the graph of the current refs
    /// is not computed yet (every `row` is then `None`: use `graph_index_of`).
    pub graph_version: Option<u32>,
    pub head: HeadState,
    pub local: Vec<LocalBranch>,
    pub remotes: Vec<RemoteRefs>,
    pub tags: Vec<TagRef>,
    pub stashes: Vec<StashRef>,
    pub submodules: Vec<SubmoduleRef>,
    pub worktrees: Vec<WorktreeRef>,
}

/// Hash of HEAD, every ref target and the stash reflog: equal fingerprints mean the graph
/// computed for one is valid for the other. Checked on every graph request.
pub fn refs_fingerprint(repo: &gix::Repository) -> Result<u64, YagguiError> {
    fingerprint_with(repo, ref_targets_hash(repo)?)
}

/// The costly part of the fingerprint: every ref name and target (tens of thousands of loose
/// ref files to read in some repositories). A session with a watcher reuses it until refs
/// change on disk.
pub fn ref_targets_hash(repo: &gix::Repository) -> Result<u64, YagguiError> {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let platform = repo.references().map_err(gix("list refs"))?;
    for reference in platform.all().map_err(gix("list refs"))? {
        let reference = reference.map_err(gix("list refs"))?;
        reference.name().as_bstr().hash(&mut hasher);
        match reference.target() {
            gix::refs::TargetRef::Object(id) => id.as_bytes().hash(&mut hasher),
            gix::refs::TargetRef::Symbolic(name) => name.as_bstr().hash(&mut hasher),
        }
    }
    Ok(hasher.finish())
}

/// The fingerprint from the ref targets hash, HEAD and the files the watcher ignores.
pub fn fingerprint_with(repo: &gix::Repository, targets: u64) -> Result<u64, YagguiError> {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    targets.hash(&mut hasher);
    let head = repo.head().map_err(gix("read HEAD"))?;
    head.referent_name()
        .map(|n| n.as_bstr().to_owned())
        .hash(&mut hasher);
    head.id().map(|id| id.detach()).hash(&mut hasher);
    // `git stash drop` rewrites the reflog without moving `refs/stash`; `fetch --deepen`
    // rewrites `.git/shallow`.
    for file in ["logs/refs/stash", "shallow"] {
        if let Ok(metadata) = std::fs::metadata(repo.common_dir().join(file)) {
            metadata.len().hash(&mut hasher);
            metadata.modified().ok().hash(&mut hasher);
        }
    }
    Ok(hasher.finish())
}

/// A stash entry, newest first.
pub struct StashEntry {
    pub id: ObjectId,
    pub base: Option<ObjectId>,
    /// Third parent: the untracked files, when stashed with `--include-untracked`.
    pub untracked: Option<ObjectId>,
    pub message: String,
}

/// Entries of the `refs/stash` reflog, newest first (`stash@{0}` first).
pub fn read_stashes(repo: &gix::Repository) -> Result<Vec<StashEntry>, YagguiError> {
    let Some(reference) = repo
        .try_find_reference("refs/stash")
        .map_err(gix("find refs/stash"))?
    else {
        return Ok(Vec::new());
    };
    let mut platform = reference.log_iter();
    let Some(lines) = platform
        .all()
        .map_err(|e| BackendError::io("read the stash reflog", e))?
    else {
        return Ok(Vec::new());
    };
    let mut entries = Vec::new();
    for line in lines {
        let Ok(line) = line else { continue };
        let Ok(id) = ObjectId::from_hex(line.new_oid) else {
            continue;
        };
        let parents: Vec<ObjectId> = repo
            .find_commit(id)
            .map(|commit| commit.parent_ids().map(|p| p.detach()).collect())
            .unwrap_or_default();
        entries.push(StashEntry {
            id,
            base: parents.first().copied(),
            untracked: parents.get(2).copied(),
            message: line.message.to_str_lossy().into_owned(),
        });
    }
    entries.reverse();
    Ok(entries)
}

/// Refs as the graph needs them: the commits to start from and the labels to show.
pub struct GraphRefs {
    /// Commits of every branch, remote branch, tag and HEAD, in Git's ref order (sorted
    /// names, HEAD last), used to break date ties like `git log`.
    pub tips: Vec<ObjectId>,
    pub labels: Vec<(ObjectId, RefLabel)>,
    /// HEAD commit and the name its color derives from.
    pub head: Option<(ObjectId, String)>,
}

fn label(kind: RefKind, name: String, full_name: String) -> RefLabel {
    RefLabel {
        kind,
        name,
        full_name,
        is_head: false,
        upstream: None,
    }
}

/// Short upstream name of a local branch (`origin/main`), if configured.
fn upstream_name(repo: &gix::Repository, full_name: &gix::refs::FullNameRef) -> Option<String> {
    match repo.branch_remote_tracking_ref_name(full_name, gix::remote::Direction::Fetch)? {
        Ok(name) => Some(name.shorten().to_string()),
        Err(err) => {
            tracing::debug!(error = %err, "cannot resolve an upstream branch");
            None
        }
    }
}

/// Peels a ref to the commit it designates, `None` for tags on trees or blobs.
fn peel_to_commit(
    repo: &gix::Repository,
    reference: &mut gix::Reference<'_>,
    packed: Option<&gix::refs::packed::Buffer>,
) -> Option<ObjectId> {
    let id = reference.peel_to_id_packed(packed).ok()?.detach();
    let header = repo.find_header(id).ok()?;
    (header.kind() == gix::objs::Kind::Commit).then_some(id)
}

pub fn graph_refs(repo: &gix::Repository) -> Result<GraphRefs, YagguiError> {
    let head_name = repo.head_name().map_err(gix("read HEAD"))?;
    let packed = repo
        .refs
        .cached_packed_buffer()
        .map_err(gix("read packed refs"))?;
    let packed = packed.as_ref().map(|p| &***p);

    let mut tips = Vec::new();
    let mut labels = Vec::new();
    let platform = repo.references().map_err(gix("list refs"))?;
    for reference in platform.all().map_err(gix("list refs"))? {
        let mut reference = reference.map_err(gix("list refs"))?;
        if matches!(reference.target(), gix::refs::TargetRef::Symbolic(_)) {
            continue; // `origin/HEAD`: its target is listed on its own.
        }
        let full = reference.name().as_bstr().to_string();
        let kind = if full.starts_with("refs/heads/") {
            RefKind::LocalBranch
        } else if full.starts_with("refs/remotes/") {
            RefKind::RemoteBranch
        } else if full.starts_with("refs/tags/") {
            RefKind::Tag
        } else {
            continue; // stash (labels below), notes, pull requests…
        };
        let Some(id) = peel_to_commit(repo, &mut reference, packed) else {
            continue;
        };
        let mut l = label(kind, reference.name().shorten().to_string(), full);
        if kind == RefKind::LocalBranch {
            l.is_head = head_name
                .as_ref()
                .is_some_and(|h| h.as_ref() == reference.name());
            l.upstream = upstream_name(repo, reference.name());
        }
        tips.push(id);
        labels.push((id, l));
    }

    let head = match read_head(repo)? {
        HeadState::Branch { name, oid } => {
            ObjectId::from_hex(oid.as_bytes()).ok().map(|id| (id, name))
        }
        HeadState::Detached { oid } => {
            let id = ObjectId::from_hex(oid.as_bytes()).ok();
            if let Some(id) = id {
                labels.push((id, {
                    let mut l = label(RefKind::Head, "HEAD".into(), "HEAD".into());
                    l.is_head = true;
                    l
                }));
            }
            id.map(|id| (id, oid))
        }
        HeadState::Unborn { .. } => None,
    };
    if let Some((id, _)) = &head {
        tips.push(*id);
    }

    for (index, stash) in read_stashes(repo)?.into_iter().enumerate() {
        if let Some(base) = stash.base {
            labels.push((
                base,
                label(
                    RefKind::Stash,
                    format!("stash@{{{index}}}"),
                    "refs/stash".into(),
                ),
            ));
        }
    }
    Ok(GraphRefs { tips, labels, head })
}

/// What `read_refs` derives from objects, kept across calls: objects never change, and from
/// one listing to the next most refs still point to the same ones.
#[derive(Default)]
pub struct RefsCache {
    counts: ahead_behind::PairCache,
    /// Tag object (or commit, for a lightweight tag) → what the listing shows.
    tags: gix::hashtable::HashMap<ObjectId, PeeledTag>,
}

impl RefsCache {
    const MAX_TAGS: usize = 100_000;
}

#[derive(Clone)]
struct PeeledTag {
    peeled: ObjectId,
    annotated: bool,
    message: Option<String>,
}

fn peel_tag(repo: &gix::Repository, direct: ObjectId, peeled: ObjectId) -> PeeledTag {
    let annotation = (peeled != direct)
        .then(|| repo.find_tag(direct).ok())
        .flatten();
    let message = annotation.as_ref().and_then(|tag| {
        let decoded = tag.decode().ok()?;
        let summary = decoded.message.lines().next().unwrap_or_default();
        Some(summary.to_str_lossy().trim().to_owned())
    });
    PeeledTag {
        peeled,
        annotated: annotation.is_some(),
        message,
    }
}

/// Everything `list_refs` returns except the graph rows, with the commit of each entry.
///
/// `cache` keeps the ahead/behind counts across calls.
pub fn read_refs(repo: &gix::Repository, cache: &mut RefsCache) -> Result<RepoRefs, YagguiError> {
    let head = read_head(repo)?;
    let head_name = repo.head_name().map_err(gix("read HEAD"))?;
    let packed = repo
        .refs
        .cached_packed_buffer()
        .map_err(gix("read packed refs"))?;
    let packed = packed.as_ref().map(|p| &***p);

    let mut counter = ahead_behind::Counter::new(repo);
    let mut local = Vec::new();
    let mut remote_branches: Vec<RemoteBranch> = Vec::new();
    let mut tags = Vec::new();
    let platform = repo.references().map_err(gix("list refs"))?;
    for reference in platform.all().map_err(gix("list refs"))? {
        let mut reference = reference.map_err(gix("list refs"))?;
        if matches!(reference.target(), gix::refs::TargetRef::Symbolic(_)) {
            continue;
        }
        let full_name = reference.name().as_bstr().to_string();
        let name = reference.name().shorten().to_string();
        if full_name.starts_with("refs/heads/") {
            // Branches point to commits: no peeling (an object lookup per ref).
            let gix::refs::TargetRef::Object(id) = reference.target() else {
                continue;
            };
            let id = id.to_owned();
            let upstream =
                upstream_state(repo, reference.name(), id, &mut counter, &mut cache.counts)?;
            local.push(LocalBranch {
                is_head: head_name
                    .as_ref()
                    .is_some_and(|h| h.as_ref() == reference.name()),
                name,
                full_name,
                sha: id.to_string(),
                upstream,
                row: None,
            });
        } else if full_name.starts_with("refs/remotes/") {
            // Remote-tracking refs point to commits: no peeling (an object lookup per ref).
            let gix::refs::TargetRef::Object(id) = reference.target() else {
                continue;
            };
            remote_branches.push(RemoteBranch {
                name,
                full_name,
                sha: id.to_string(),
                row: None,
            });
        } else if full_name.starts_with("refs/tags/") {
            let gix::refs::TargetRef::Object(direct) = reference.target() else {
                continue;
            };
            let direct = direct.to_owned();
            let tag = match cache.tags.get(&direct) {
                Some(tag) => tag.clone(),
                None => {
                    let Ok(peeled) = reference.peel_to_id_packed(packed) else {
                        continue;
                    };
                    let tag = peel_tag(repo, direct, peeled.detach());
                    if cache.tags.len() >= RefsCache::MAX_TAGS {
                        cache.tags.clear();
                    }
                    cache.tags.insert(direct, tag.clone());
                    tag
                }
            };
            tags.push(TagRef {
                name,
                full_name,
                sha: tag.peeled.to_string(),
                annotated: tag.annotated,
                message: tag.message,
                row: None,
            });
        }
    }

    let config = repo.config_snapshot();
    let mut remotes: Vec<RemoteRefs> = repo
        .remote_names()
        .into_iter()
        .map(|name| {
            let push_url = config
                .string(format!("remote.{name}.pushurl").as_str())
                .map(|url| url.to_string());
            let url = repo.find_remote(name.as_bstr()).ok().and_then(|r| {
                r.url(gix::remote::Direction::Fetch)
                    .map(|u| u.to_bstring().to_string())
            });
            RemoteRefs {
                name: name.to_string(),
                url,
                push_url,
                branches: Vec::new(),
            }
        })
        .collect();
    for branch in remote_branches {
        // The longest matching remote name wins (`origin` vs `origin/mirror`).
        let owner = remotes
            .iter_mut()
            .filter(|r| branch.name.starts_with(&format!("{}/", r.name)))
            .max_by_key(|r| r.name.len());
        match owner {
            Some(remote) => remote.branches.push(branch),
            None => {
                let name = branch.name.split('/').next().unwrap_or_default().to_owned();
                match remotes.iter_mut().find(|r| r.name == name) {
                    Some(remote) => remote.branches.push(branch),
                    None => remotes.push(RemoteRefs {
                        name,
                        url: None,
                        push_url: None,
                        branches: vec![branch],
                    }),
                }
            }
        }
    }
    remotes.sort_by(|a, b| a.name.cmp(&b.name));

    let stashes = read_stashes(repo)?
        .into_iter()
        .enumerate()
        .map(|(index, s)| StashRef {
            index: index as u32,
            name: format!("stash@{{{index}}}"),
            message: s.message,
            sha: s.id.to_string(),
            base_sha: s.base.map(|b| b.to_string()).unwrap_or_default(),
            untracked_sha: s.untracked.map(|u| u.to_string()),
            row: None,
        })
        .collect();

    Ok(RepoRefs {
        graph_version: None,
        head,
        local,
        remotes,
        tags,
        stashes,
        submodules: read_submodules(repo),
        worktrees: read_worktrees(repo),
    })
}

fn upstream_state(
    repo: &gix::Repository,
    branch: &gix::refs::FullNameRef,
    local_id: ObjectId,
    counter: &mut Option<ahead_behind::Counter<'_>>,
    cache: &mut ahead_behind::PairCache,
) -> Result<Option<UpstreamState>, YagguiError> {
    let tracking = match repo.branch_remote_tracking_ref_name(branch, gix::remote::Direction::Fetch)
    {
        None | Some(Err(_)) => return Ok(None),
        Some(Ok(name)) => name,
    };
    let name = tracking.shorten().to_string();
    let Some(mut upstream) = repo
        .try_find_reference(tracking.as_ref())
        .map_err(gix("find upstream"))?
    else {
        return Ok(Some(UpstreamState {
            name,
            ahead: 0,
            behind: 0,
            gone: true,
        }));
    };
    let upstream_id = match upstream.target() {
        gix::refs::TargetRef::Object(id) => id.to_owned(),
        gix::refs::TargetRef::Symbolic(_) => upstream
            .peel_to_id()
            .map_err(gix("peel upstream"))?
            .detach(),
    };
    let counted = cache
        .get(local_id, upstream_id)
        .or_else(|| counter.as_mut()?.count(local_id, upstream_id));
    let (ahead, behind) = match counted {
        Some(counts) => counts,
        None => {
            let counts = count_exclusive(repo, local_id, upstream_id)
                .and_then(|ahead| Ok((ahead, count_exclusive(repo, upstream_id, local_id)?)));
            match counts {
                Ok(counts) => counts,
                Err(err) => {
                    // An unreadable commit (corruption, partial clone): this branch shows no
                    // upstream state rather than failing the whole listing.
                    tracing::warn!(branch = %branch.as_bstr(), error = %err, "ahead/behind unavailable");
                    return Ok(None);
                }
            }
        }
    };
    cache.insert(local_id, upstream_id, (ahead, behind));
    Ok(Some(UpstreamState {
        name,
        ahead,
        behind,
        gone: false,
    }))
}

/// Submodules declared in `.gitmodules`; unreadable entries are skipped (logged).
fn read_submodules(repo: &gix::Repository) -> Vec<SubmoduleRef> {
    let modules = match repo.submodules() {
        Ok(Some(modules)) => modules,
        Ok(None) => return Vec::new(),
        Err(err) => {
            tracing::warn!(error = %err, "cannot read .gitmodules");
            return Vec::new();
        }
    };
    let mut out: Vec<SubmoduleRef> = modules
        .filter_map(|module| {
            let path = module.path().ok()?.to_string();
            Some(SubmoduleRef {
                name: module.name().to_string(),
                url: module.url().ok().map(|u| u.to_bstring().to_string()),
                sha: module.index_id().ok().flatten().map(|id| id.to_string()),
                initialized: module.state().is_ok_and(|s| s.repository_exists),
                path,
            })
        })
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// The main worktree first, then the linked ones by path.
pub(crate) fn read_worktrees(repo: &gix::Repository) -> Vec<WorktreeRef> {
    let current = repo.workdir().map(normalize);
    let mut out = Vec::new();
    let main_repo = repo.main_repo().ok();
    if let Some(main) = &main_repo
        && let Some(path) = main.workdir()
    {
        let path = normalize(path);
        out.push(WorktreeRef {
            is_current: current.as_ref() == Some(&path),
            path: path.display().to_string(),
            head: read_head(main).ok(),
            is_main: true,
            locked: false,
            prunable: false,
        });
    }
    let linked = main_repo
        .as_ref()
        .map_or_else(|| repo.worktrees(), |m| m.worktrees())
        .unwrap_or_default();
    let mut others: Vec<WorktreeRef> = linked
        .into_iter()
        .filter_map(|proxy| {
            let path = normalize(&proxy.base().ok()?);
            let locked = proxy.is_locked();
            let prunable = !path.exists();
            let head = proxy
                .into_repo_with_possibly_inaccessible_worktree()
                .ok()
                .and_then(|r| read_head(&r).ok());
            Some(WorktreeRef {
                is_current: current.as_ref() == Some(&path),
                path: path.display().to_string(),
                head,
                is_main: false,
                locked,
                prunable,
            })
        })
        .collect();
    others.sort_by(|a, b| a.path.cmp(&b.path));
    out.extend(others);
    out
}

fn normalize(path: &std::path::Path) -> std::path::PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}
