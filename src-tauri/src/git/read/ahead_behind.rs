//! Ahead/behind counts of many branch/upstream pairs.
//!
//! A `rev_walk` with hidden tips costs milliseconds per pair on a merge-heavy history (24 s
//! for 2 000 tracking branches of git/git). With generation numbers, one walk from both tips
//! in generation order stops as soon as every queued commit is reachable from both sides.
//! Generations come from the commit-graph; commits newer than the file get theirs computed
//! from their parents. Without a commit-graph, or when too many commits are outside it, the
//! caller falls back to the walk.

use std::collections::BinaryHeap;

use gix::ObjectId;
use gix::commitgraph::{Graph, Position};
use gix::objs::Find;

/// Commits outside the commit-graph whose generation may be computed, for all the pairs of
/// one `Counter`. Beyond, decoding them costs more than the walk it would replace.
const MAX_OUTSIDE_GRAPH: usize = 5_000;

const LEFT: u8 = 1;
const RIGHT: u8 = 2;
const BOTH: u8 = LEFT | RIGHT;

/// A commit: its commit-graph position, or `graph_len + i` for the i-th commit outside it.
type Node = u32;

/// A commit outside the commit-graph.
struct Outside {
    generation: u32,
    parents: Vec<Node>,
}

/// Counts ahead/behind for several pairs, sharing what it decoded.
pub struct Counter<'repo> {
    repo: &'repo gix::Repository,
    graph: Graph,
    graph_len: u32,
    outside: Vec<Outside>,
    outside_index: gix::hashtable::HashMap<ObjectId, Node>,
    /// Per-node flags of the current count; only the `touched` entries are non-zero.
    flags: Vec<u8>,
    touched: Vec<Node>,
    buf: Vec<u8>,
}

impl<'repo> Counter<'repo> {
    /// `None` when the repository has no usable commit-graph.
    pub fn new(repo: &'repo gix::Repository) -> Option<Self> {
        let graph = repo.commit_graph_if_enabled().ok().flatten()?;
        let graph_len = graph.num_commits();
        // Files written by Git < 2.19 have no generation numbers (all 0): the walk below needs
        // a parent's generation to be lower than its children's.
        if graph_len == 0 || graph.commit_at(Position(0)).generation() == 0 {
            return None;
        }
        Some(Self {
            repo,
            graph,
            graph_len,
            outside: Vec::new(),
            outside_index: Default::default(),
            flags: Vec::new(),
            touched: Vec::new(),
            buf: Vec::new(),
        })
    }

    /// `(ahead, behind)`: commits reachable from `local` only, and from `upstream` only.
    /// `None` when it cannot be computed this way (unreadable commit, too many commits
    /// outside the commit-graph).
    pub fn count(&mut self, local: ObjectId, upstream: ObjectId) -> Option<(u32, u32)> {
        if local == upstream {
            return Some((0, 0));
        }
        let left = self.node(local)?;
        let right = self.node(upstream)?;
        self.flags
            .resize(self.graph_len as usize + self.outside.len(), 0);
        let result = self.walk(left, right);
        for node in self.touched.drain(..) {
            self.flags[node as usize] = 0;
        }
        result
    }

    fn walk(&mut self, left: Node, right: Node) -> Option<(u32, u32)> {
        let mut queue: BinaryHeap<(u32, Node)> = BinaryHeap::new();
        // Queued commits not yet known to be reachable from both sides: the walk ends at 0.
        let mut pending = 0usize;
        for (node, flag) in [(left, LEFT), (right, RIGHT)] {
            self.flags[node as usize] = flag;
            self.touched.push(node);
            queue.push((self.generation(node), node));
            pending += 1;
        }
        let (mut ahead, mut behind) = (0u32, 0u32);
        let mut parents = Vec::new();
        while pending > 0 {
            let (_, node) = queue.pop()?;
            // Final: every child has a higher generation and was popped before.
            let flag = self.flags[node as usize];
            if flag != BOTH {
                pending = pending.checked_sub(1)?;
                if flag == LEFT {
                    ahead = ahead.saturating_add(1);
                } else {
                    behind = behind.saturating_add(1);
                }
            }
            self.parents(node, &mut parents)?;
            for &parent in &parents {
                let existing = self.flags[parent as usize];
                let merged = existing | flag;
                if existing == 0 {
                    self.touched.push(parent);
                    queue.push((self.generation(parent), parent));
                    if merged != BOTH {
                        pending += 1;
                    }
                } else if existing != BOTH && merged == BOTH {
                    pending = pending.checked_sub(1)?;
                }
                self.flags[parent as usize] = merged;
            }
        }
        Some((ahead, behind))
    }

    fn generation(&self, node: Node) -> u32 {
        match node.checked_sub(self.graph_len) {
            Some(i) => self.outside[i as usize].generation,
            None => self.graph.commit_at(Position(node)).generation(),
        }
    }

    fn parents(&self, node: Node, out: &mut Vec<Node>) -> Option<()> {
        out.clear();
        match node.checked_sub(self.graph_len) {
            Some(i) => out.extend_from_slice(&self.outside[i as usize].parents),
            None => {
                for parent in self.graph.commit_at(Position(node)).iter_parents() {
                    out.push(parent.ok()?.0);
                }
            }
        }
        Some(())
    }

    /// Node of a commit, decoding it (and its ancestors outside the commit-graph) if needed.
    fn node(&mut self, id: ObjectId) -> Option<Node> {
        if let Some(node) = self.known(&id) {
            return Some(node);
        }
        // Depth-first, without recursion: a commit is added once its parents are known.
        let mut stack: Vec<(ObjectId, Option<Vec<ObjectId>>)> = vec![(id, None)];
        while let Some((current, decoded)) = stack.pop() {
            if self.known(&current).is_some() {
                continue;
            }
            let parents = match decoded {
                Some(parents) => parents,
                None => self.decode_parents(current)?,
            };
            let missing: Vec<ObjectId> = parents
                .iter()
                .filter(|p| self.known(p).is_none())
                .copied()
                .collect();
            if !missing.is_empty() {
                stack.push((current, Some(parents)));
                stack.extend(missing.into_iter().map(|p| (p, None)));
                continue;
            }
            if self.outside.len() >= MAX_OUTSIDE_GRAPH {
                return None;
            }
            let parents: Vec<Node> = parents.iter().filter_map(|p| self.known(p)).collect();
            let generation = parents
                .iter()
                .map(|&p| self.generation(p))
                .max()
                .unwrap_or(0)
                .saturating_add(1);
            let node = self.graph_len + self.outside.len() as u32;
            self.outside.push(Outside {
                generation,
                parents,
            });
            self.outside_index.insert(current, node);
        }
        self.known(&id)
    }

    fn known(&self, id: &ObjectId) -> Option<Node> {
        match self.graph.lookup(id) {
            Some(pos) => Some(pos.0),
            None => self.outside_index.get(id).copied(),
        }
    }

    fn decode_parents(&mut self, id: ObjectId) -> Option<Vec<ObjectId>> {
        let data = self.repo.objects.try_find(&id, &mut self.buf).ok()??;
        if data.kind != gix::objs::Kind::Commit {
            return None;
        }
        let mut parents = Vec::new();
        for token in gix::objs::CommitRefIter::from_bytes(data.data, id.kind()) {
            match token.ok()? {
                gix::objs::commit::ref_iter::Token::Parent { id } => parents.push(id),
                gix::objs::commit::ref_iter::Token::Tree { .. } => {}
                _ => break,
            }
        }
        Some(parents)
    }
}

/// Counts already computed, by `(local, upstream)`: commits never change, so a pair keeps
/// its counts; most pairs are the same from one refs listing to the next.
#[derive(Default)]
pub struct PairCache(gix::hashtable::HashMap<(ObjectId, ObjectId), (u32, u32)>);

impl PairCache {
    /// Bound on the entries; the cache is emptied when reached (rare: thousands of branches
    /// moving).
    const MAX_ENTRIES: usize = 50_000;

    pub fn get(&self, local: ObjectId, upstream: ObjectId) -> Option<(u32, u32)> {
        self.0.get(&(local, upstream)).copied()
    }

    pub fn insert(&mut self, local: ObjectId, upstream: ObjectId, counts: (u32, u32)) {
        if self.0.len() >= Self::MAX_ENTRIES {
            self.0.clear();
        }
        self.0.insert((local, upstream), counts);
    }
}
