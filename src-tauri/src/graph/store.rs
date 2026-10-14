//! Commit DAG of a repository: ids, parents and committer dates of every commit loaded so
//! far, kept across refreshes (commits are immutable, only the refs move).
//!
//! Commits of the `commit-graph` file are nodes `0..graph_len` (their graph position): their
//! data is read from the memory-mapped file on demand, nothing is copied. Other commits
//! (newer than the file, or every commit when there is no file) are decoded from the object
//! database once and stored after them.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use gix::ObjectId;
use gix::commitgraph::Graph;
use gix::objs::Find;

use crate::git::errors::{BackendError, YagguiError};

/// Index of a commit in the store.
pub type Node = u32;

/// Generation of a commit without a known one (Git's `GENERATION_NUMBER_INFINITY`).
pub const GENERATION_INFINITY: u32 = u32::MAX;

/// `parent_start` of a stored commit not decoded yet.
const UNLOADED: u32 = u32::MAX;
/// `parent_start` of a commit whose object is missing (shallow clone boundary, corruption).
const MISSING: u32 = u32::MAX - 1;

/// Identity of the commit-graph files, to notice when Git rewrites them (gc, fetch).
type GraphStamp = Vec<Option<(SystemTime, u64)>>;

pub struct CommitStore {
    graph: Option<Graph>,
    graph_len: u32,
    /// Generation numbers of the commit-graph are usable (files written by Git before 2.18
    /// leave them at zero).
    generations: bool,
    files: GraphFiles,
    // Commits outside the commit-graph, nodes `graph_len..`.
    ids: Vec<ObjectId>,
    times: Vec<i64>,
    parent_start: Vec<u32>,
    parent_len: Vec<u16>,
    parents: Vec<Node>,
    index: gix::hashtable::HashMap<ObjectId, Node>,
    /// Boundary commits of a shallow clone (`.git/shallow`): Git treats them as roots.
    shallow: std::collections::HashSet<Node>,
}

impl CommitStore {
    pub fn new(repo: &gix::Repository) -> Self {
        let graph = match repo.commit_graph_if_enabled() {
            Ok(graph) => graph,
            Err(err) => {
                // A broken commit-graph is only a slower path: read the objects instead.
                tracing::warn!(error = %err, "commit-graph unusable, reading commits from objects");
                None
            }
        };
        let objects_dir = repo.objects.store_ref().path().to_path_buf();
        let graph_len = graph.as_ref().map_or(0, Graph::num_commits);
        let generations = graph.as_ref().is_some_and(|graph| {
            graph_len > 0
                && [0, graph_len - 1].iter().all(|&pos| {
                    graph
                        .commit_at(gix::commitgraph::Position(pos))
                        .generation()
                        > 0
                })
        });
        Self {
            graph_len,
            generations,
            graph,
            files: GraphFiles {
                stamp: graph_stamp(&objects_dir),
                objects_dir,
            },
            ids: Vec::new(),
            times: Vec::new(),
            parent_start: Vec::new(),
            parent_len: Vec::new(),
            parents: Vec::new(),
            index: Default::default(),
            shallow: Default::default(),
        }
    }

    /// A copy sharing nothing with `self`, for a rebuild while a reader still holds `self`:
    /// copying the decoded commits is much cheaper than decoding them again.
    pub fn duplicate(&self, repo: &gix::Repository) -> Self {
        let graph = match &self.graph {
            None => None,
            Some(_) => match repo.commit_graph_if_enabled() {
                Ok(Some(graph)) if graph.num_commits() == self.graph_len => Some(graph),
                // The file changed in between: node numbers would not match.
                _ => return Self::new(repo),
            },
        };
        Self {
            graph,
            graph_len: self.graph_len,
            generations: self.generations,
            files: self.files.clone(),
            ids: self.ids.clone(),
            times: self.times.clone(),
            parent_start: self.parent_start.clone(),
            parent_len: self.parent_len.clone(),
            parents: self.parents.clone(),
            index: self.index.clone(),
            shallow: self.shallow.clone(),
        }
    }

    /// Reads `.git/shallow` again (a fetch can deepen or shorten the history).
    pub fn load_shallow(&mut self, repo: &gix::Repository) -> Result<(), YagguiError> {
        let commits = repo
            .shallow_commits()
            .map_err(|err| BackendError::gix("read .git/shallow", err))?;
        self.shallow.clear();
        for id in commits.iter().flat_map(|c| c.iter()) {
            let node = self.node_of(*id);
            self.shallow.insert(node);
        }
        Ok(())
    }

    /// The commit-graph files this store was created with.
    pub fn files(&self) -> &GraphFiles {
        &self.files
    }

    /// See [`GraphFiles::is_stale`].
    pub fn is_stale(&self) -> bool {
        self.files.is_stale()
    }

    pub fn has_commit_graph(&self) -> bool {
        self.graph.is_some()
    }

    /// Commits known to the store but not to the commit-graph file.
    pub fn outside_graph(&self) -> usize {
        self.ids.len()
    }

    pub fn len(&self) -> usize {
        self.graph_len as usize + self.ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Node of a commit already known to the store.
    pub fn lookup(&self, id: &gix::oid) -> Option<Node> {
        if let Some(graph) = &self.graph
            && let Some(pos) = graph.lookup(id)
        {
            return Some(pos.0);
        }
        self.index.get(id).copied()
    }

    /// Node of a commit, added (not decoded) if unknown.
    pub fn node_of(&mut self, id: ObjectId) -> Node {
        if let Some(node) = self.lookup(&id) {
            return node;
        }
        let node = self.graph_len + self.ids.len() as u32;
        self.ids.push(id);
        self.times.push(0);
        self.parent_start.push(UNLOADED);
        self.parent_len.push(0);
        self.index.insert(id, node);
        node
    }

    pub fn id(&self, node: Node) -> ObjectId {
        match self.extra(node) {
            Some(i) => self.ids[i],
            None => self.graph_commit(node).id().to_owned(),
        }
    }

    /// Committer date, seconds since the epoch.
    pub fn time(&self, node: Node) -> i64 {
        match self.extra(node) {
            Some(i) => self.times[i],
            None => i64::try_from(self.graph_commit(node).committer_timestamp()).unwrap_or(0),
        }
    }

    /// Generation number from the commit-graph, `GENERATION_INFINITY` for a commit outside
    /// it (or when the file has none): every child has a greater generation than its parents.
    pub fn generation(&self, node: Node) -> u32 {
        match self.extra(node) {
            None if self.generations => self.graph_commit(node).generation(),
            _ => GENERATION_INFINITY,
        }
    }

    /// Root tree, when known without reading the commit object.
    pub fn root_tree(&self, node: Node) -> Option<ObjectId> {
        match self.extra(node) {
            Some(_) => None,
            None => Some(self.graph_commit(node).root_tree_id().to_owned()),
        }
    }

    /// `false` when the commit object could not be read (shallow boundary).
    pub fn is_present(&self, node: Node) -> bool {
        self.extra(node)
            .is_none_or(|i| self.parent_start[i] != MISSING)
    }

    /// Parents of a loaded commit, first parent first, appended to `out` (cleared first).
    pub fn parents_into(&self, node: Node, out: &mut Vec<Node>) {
        out.clear();
        if self.shallow.contains(&node) {
            return;
        }
        match self.extra(node) {
            Some(i) => {
                let start = self.parent_start[i];
                if start < MISSING {
                    let start = start as usize;
                    out.extend_from_slice(
                        &self.parents[start..start + usize::from(self.parent_len[i])],
                    );
                }
            }
            None => out.extend(
                self.graph_commit(node)
                    .iter_parents()
                    // An unreadable edge in the file only drops that parent.
                    .filter_map(Result::ok)
                    .map(|pos| pos.0),
            ),
        }
    }

    /// Decodes a commit stored outside the commit-graph if not done yet.
    pub fn ensure_loaded(
        &mut self,
        objects: &gix::OdbHandle,
        node: Node,
        buf: &mut Vec<u8>,
    ) -> Result<(), YagguiError> {
        let Some(i) = self.extra(node) else {
            return Ok(());
        };
        if self.parent_start[i] != UNLOADED {
            return Ok(());
        }
        let id = self.ids[i];
        let data = objects
            .try_find(&id, buf)
            .map_err(|err| BackendError::gix("read a commit", err))?;
        let Some(data) = data.filter(|d| d.kind == gix::objs::Kind::Commit) else {
            self.parent_start[i] = MISSING;
            return Ok(());
        };
        let iter = gix::objs::CommitRefIter::from_bytes(data.data, id.kind());
        let mut time = 0;
        let mut parent_ids: Vec<ObjectId> = Vec::new();
        for token in iter {
            match token {
                Ok(gix::objs::commit::ref_iter::Token::Parent { id }) => parent_ids.push(id),
                Ok(gix::objs::commit::ref_iter::Token::Committer { signature }) => {
                    time = signature.seconds();
                    break;
                }
                Ok(_) => {}
                Err(err) => return Err(BackendError::gix("decode a commit", err).into()),
            }
        }
        let start = u32::try_from(self.parents.len())
            .map_err(|_| YagguiError::internal("too many commit parents"))?;
        for parent in parent_ids.iter().take(usize::from(u16::MAX)) {
            let parent = self.node_of(*parent);
            self.parents.push(parent);
        }
        self.parent_start[i] = start;
        self.parent_len[i] = parent_ids.len().min(usize::from(u16::MAX)) as u16;
        self.times[i] = time;
        Ok(())
    }

    /// Decodes the commit if needed; `false` when its object is missing.
    pub fn load(
        &mut self,
        objects: &gix::OdbHandle,
        node: Node,
        buf: &mut Vec<u8>,
    ) -> Result<bool, YagguiError> {
        self.ensure_loaded(objects, node, buf)?;
        Ok(self.is_present(node))
    }

    fn extra(&self, node: Node) -> Option<usize> {
        node.checked_sub(self.graph_len).map(|i| i as usize)
    }

    fn graph_commit(&self, node: Node) -> gix::commitgraph::file::Commit<'_> {
        // Invariant: nodes below `graph_len` only exist when the graph does.
        let graph = self
            .graph
            .as_ref()
            .expect("graph node without commit-graph");
        graph.commit_at(gix::commitgraph::Position(node))
    }
}

/// Where the commit-graph files are and what they were when a store was created.
#[derive(Clone)]
pub struct GraphFiles {
    objects_dir: PathBuf,
    stamp: GraphStamp,
}

impl GraphFiles {
    /// The commit-graph files changed since the store was created: node numbers of the
    /// graph commits are no longer valid, a new store is needed.
    pub fn is_stale(&self) -> bool {
        graph_stamp(&self.objects_dir) != self.stamp
    }
}

fn graph_stamp(objects_dir: &Path) -> GraphStamp {
    let info = objects_dir.join("info");
    [
        info.join("commit-graph"),
        info.join("commit-graphs").join("commit-graph-chain"),
    ]
    .iter()
    .map(|path| {
        let metadata = std::fs::metadata(path).ok()?;
        Some((metadata.modified().ok()?, metadata.len()))
    })
    .collect()
}
