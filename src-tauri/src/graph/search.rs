//! Commit search (F-027), scanned in short chunks so the UI stays responsive and the search
//! can be abandoned at any time. Rows the history walk has not reached yet are walked first:
//! `total_rows` grows until the walk is done.

use std::time::{Duration, Instant};

use gix::ObjectId;
use gix::bstr::ByteSlice;
use gix::objs::Find;

use super::types::{CommitSearch, SearchChunk};
use super::{ScanRow, Snapshot};
use crate::git::errors::{BackendError, YagguiError};

/// Time spent scanning per call.
pub const SEARCH_BUDGET: Duration = Duration::from_millis(120);
/// Matches returned per call at most, to keep the payload small.
const MAX_MATCHES: usize = 5_000;
/// Rows taken from the graph at once.
const SCAN_BATCH: u32 = 256;

/// Normalized criteria.
struct Criteria {
    text: Option<String>,
    author: Option<String>,
    path: Option<String>,
    since: Option<i64>,
    until: Option<i64>,
}

impl Criteria {
    fn new(query: &CommitSearch) -> Self {
        let clean = |value: &Option<String>| {
            value
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_lowercase)
        };
        Self {
            text: clean(&query.text),
            author: clean(&query.author),
            path: query
                .path
                .as_deref()
                .map(|p| p.trim().trim_matches('/').replace('\\', "/"))
                .filter(|p| !p.is_empty()),
            since: query.since.map(|t| t.floor() as i64),
            until: query.until.map(|t| t.floor() as i64),
        }
    }

    fn is_empty(&self) -> bool {
        self.text.is_none()
            && self.author.is_none()
            && self.path.is_none()
            && self.since.is_none()
            && self.until.is_none()
    }

    fn needs_commit(&self) -> bool {
        self.text.is_some() || self.author.is_some() || self.since.is_some() || self.until.is_some()
    }
}

pub fn search(
    repo: &gix::Repository,
    snapshot: &Snapshot,
    query: &CommitSearch,
    from_row: u32,
    budget: Duration,
) -> Result<SearchChunk, YagguiError> {
    let criteria = Criteria::new(query);
    let mut chunk = SearchChunk {
        version: snapshot.version,
        matches: Vec::new(),
        next_row: None,
        total_rows: 0,
    };
    if criteria.is_empty() {
        chunk.total_rows = snapshot.total_rows();
        return Ok(chunk);
    }
    let mut repo = repo.clone();
    // Path lookups read the same top-level trees over and over.
    repo.object_cache_size_if_unset(32 * 1024 * 1024);
    let started = Instant::now();
    let mut buf = Vec::new();
    let mut row = from_row;
    'scan: loop {
        // Rows further down than the history walk got are walked first.
        let rows = snapshot.scan_rows(&repo.objects, row, SCAN_BATCH)?;
        if rows.is_empty() {
            break;
        }
        for scanned in rows {
            row = scanned.row;
            if started.elapsed() >= budget || chunk.matches.len() >= MAX_MATCHES {
                chunk.next_row = Some(row);
                break 'scan;
            }
            let ScanRow {
                id,
                mut tree,
                parent,
                ..
            } = scanned;
            let mut matched = true;
            if criteria.needs_commit() {
                let data = repo
                    .objects
                    .try_find(&id, &mut buf)
                    .map_err(|err| BackendError::gix("read a commit", err))?
                    .ok_or_else(|| YagguiError::internal(format!("commit {id} not found")))?;
                let commit = gix::objs::CommitRef::from_bytes(data.data, id.kind())
                    .map_err(|err| BackendError::gix("decode a commit", err))?;
                tree.get_or_insert(commit.tree());
                matched = matches_commit(&criteria, &id, &commit);
            }
            if matched && let Some(path) = &criteria.path {
                let parent_tree = match parent {
                    Some((_, Some(tree))) => Some(tree),
                    Some((parent, None)) => commit_tree(&repo, parent).ok(),
                    None => None,
                };
                matched = touches_path(&repo, &id, tree, parent_tree, path)?;
            }
            if matched {
                chunk.matches.push(row);
            }
            row += 1;
        }
    }
    chunk.total_rows = snapshot.total_rows();
    Ok(chunk)
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack.to_str_lossy().to_lowercase().contains(needle)
}

fn matches_commit(criteria: &Criteria, id: &ObjectId, commit: &gix::objs::CommitRef<'_>) -> bool {
    let author = commit.author().ok();
    let who = |needle: &str| {
        author.is_some_and(|a| contains(a.name, needle) || contains(a.email, needle))
    };
    if let Some(text) = &criteria.text
        && !id.to_hex().to_string().starts_with(text.as_str())
        && !contains(commit.message, text)
        && !who(text)
    {
        return false;
    }
    if let Some(needle) = &criteria.author
        && !who(needle)
    {
        return false;
    }
    let time = author.map_or(0, |a| a.seconds());
    criteria.since.is_none_or(|since| time >= since)
        && criteria.until.is_none_or(|until| time <= until)
}

/// Whether the entry at `path` differs between the commit and its first parent (given by
/// its tree, `None` for a root commit).
fn touches_path(
    repo: &gix::Repository,
    id: &ObjectId,
    tree: Option<ObjectId>,
    parent_tree: Option<ObjectId>,
    path: &str,
) -> Result<bool, YagguiError> {
    let tree = match tree {
        Some(tree) => tree,
        None => commit_tree(repo, *id)?,
    };
    let entry = entry_at(repo, tree, path)?;
    let Some(parent_tree) = parent_tree else {
        return Ok(entry.is_some());
    };
    let parent_entry = entry_at(repo, parent_tree, path)?;
    Ok(entry != parent_entry)
}

fn commit_tree(repo: &gix::Repository, id: ObjectId) -> Result<ObjectId, YagguiError> {
    let commit = repo
        .find_commit(id)
        .map_err(|err| BackendError::gix("read a commit", err))?;
    Ok(commit
        .tree_id()
        .map_err(|err| BackendError::gix("decode a commit", err))?
        .detach())
}

/// Object id and mode of the entry at `path`, `None` if absent. Names match regardless of
/// case like the other search fields; an exact match wins over a case variant.
fn entry_at(
    repo: &gix::Repository,
    tree: ObjectId,
    path: &str,
) -> Result<Option<(ObjectId, u16)>, YagguiError> {
    let mut current = tree;
    let mut components = path.split('/').filter(|c| !c.is_empty()).peekable();
    while let Some(name) = components.next() {
        let tree = repo
            .find_tree(current)
            .map_err(|err| BackendError::gix("read a tree", err))?;
        let mut found = None;
        for entry in tree.iter() {
            let entry = entry.map_err(|err| BackendError::gix("decode a tree", err))?;
            if entry.filename() == name.as_bytes() {
                found = Some((entry.oid().to_owned(), entry.mode()));
                break;
            }
            if found.is_none() && same_name_ignoring_case(entry.filename(), name) {
                found = Some((entry.oid().to_owned(), entry.mode()));
            }
        }
        let Some((oid, mode)) = found else {
            return Ok(None);
        };
        if components.peek().is_none() {
            return Ok(Some((oid, mode.value())));
        }
        // A file, symlink or submodule where the path expects a folder: nothing below it in
        // this commit (reading a blob or a submodule commit as a tree would fail instead).
        if !mode.is_tree() {
            return Ok(None);
        }
        current = oid;
    }
    Ok(None)
}

fn same_name_ignoring_case(entry: &gix::bstr::BStr, name: &str) -> bool {
    if entry.is_ascii() && name.is_ascii() {
        return entry.eq_ignore_ascii_case(name.as_bytes());
    }
    entry.to_str_lossy().to_lowercase() == name.to_lowercase()
}
