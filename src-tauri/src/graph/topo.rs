//! History order: commits reachable from the tips, in `git log --topo-order` order (see the
//! one exception below), computed incrementally so the first rows are known long before the
//! whole history is read.
//!
//! The order is Git's `sort_in_topological_order` (Kahn, LIFO): starting from the tips,
//! newest first, a commit is emitted once all its children are, and the parents it releases
//! are emitted next, last parent first. Kahn needs the in-degree of a commit (its number of
//! children in the graph) before releasing it. Like Git's incremental `--topo-order`, an
//! *explore* walk counts children ahead of the emission, newest first, only as deep as needed:
//!
//! - With generation numbers (commit-graph), a commit's children all have a greater
//!   generation: once every commit of generation ≥ g(c) is explored, the in-degree of `c` is
//!   exact, and the order is exactly the one of a full sort (`full_order`).
//! - Without them (no commit-graph, or commits newer than it), committer dates stand in for
//!   generations, with a margin (`DATE_SLOP`) for clocks a little off. A commit dated long
//!   before its child is explored close to the child's date anyway, and so are the first
//!   parents after it, by steps of `LIFT_STEP` (a series made with a wrong clock: linux has
//!   such edges, up to 298 days off). Releasing a parent far below what was explored so far
//!   (a branch with years between commits) would mean exploring the whole history in
//!   between first: such a parent waits until the exploration gets within `DEFER_WINDOW`
//!   of it. Only then does the order differ from Git's, placing those commits by date; it
//!   stays topological.
//!
//! Invariants: a row is never emitted before one of its children (rows already emitted never
//! move, pages already sent stay valid), and every reachable commit becomes a row.
//!
//! When dates mislead (a clock off by more than `DATE_SLOP` on the path to a commit), a child
//! can be explored after its parent was emitted. The walk notices it (`is_broken`) — at the
//! latest when it completes, since every commit is explored before being emitted — and the
//! graph is rebuilt with a full exploration first (`exact`).

use std::collections::BinaryHeap;

use super::store::{GENERATION_INFINITY, Node};
use crate::git::errors::YagguiError;

/// Row of a node that is not in the graph (yet).
pub const NO_ROW: u32 = u32::MAX;

/// How far (seconds) a child's committer date may be below its parent's without breaking
/// the order, when there are no generation numbers.
pub const DATE_SLOP: i64 = 24 * 3600;
/// Most a commit's exploration key drops below its child's along first parents (seconds):
/// a series of commits made with a wrong clock is still explored in time.
pub const LIFT_STEP: i64 = 6 * 3600;
/// Without generation numbers, a commit released while the newest commit not explored yet
/// is more than this much newer (seconds) waits for the exploration to get closer.
pub const DEFER_WINDOW: i64 = 365 * 24 * 3600;

/// What the walk needs to know about the commits.
pub trait Dag {
    /// Nodes known so far (loading a commit can add its parents).
    fn node_count(&self) -> usize;
    /// Reads the commit if needed; `false` when its object is missing (shallow boundary,
    /// corruption): the commit is then left out like Git does.
    fn load(&mut self, node: Node) -> Result<bool, YagguiError>;
    /// Parents of a loaded commit, first parent first (`out` is cleared first).
    fn parents_into(&self, node: Node, out: &mut Vec<Node>);
    /// Committer date, seconds since the epoch.
    fn time(&self, node: Node) -> i64;
    /// Generation number, `GENERATION_INFINITY` when unknown.
    fn generation(&self, node: Node) -> u32;
}

const DISCOVERED: u8 = 1;
const MISSING: u8 = 2;
const EXPLORED: u8 = 4;

/// Incremental topological order of the commits reachable from a set of tips.
pub struct Walk {
    flags: Vec<u8>,
    /// Explored children not emitted yet.
    indegree: Vec<u32>,
    row_of: Vec<u32>,
    order: Vec<Node>,
    /// Discovered commits to explore: highest generation, then highest key first.
    explore: BinaryHeap<(u32, i64, Node)>,
    /// The same without generation number, by date: how far up the exploration still is.
    unexplored_dates: BinaryHeap<(i64, Node)>,
    /// Kahn's LIFO stack. Entries can be stale (emitted already, or a child was found since):
    /// they are checked when popped.
    stack: Vec<Node>,
    /// Commits without generation number released while the exploration was far above them
    /// (`DEFER_WINDOW`), newest first: released again once it gets close.
    deferred: BinaryHeap<(i64, Node)>,
    /// The whole history was explored first: nothing to defer.
    exact: bool,
    /// Exploration key of commits without a generation number (see `discover`).
    key: Vec<i64>,
    /// Commits found reachable so far: all of them become rows.
    discovered: u32,
    done: bool,
    broken: bool,
    parents: Vec<Node>,
}

impl Walk {
    /// Starts a walk from `tips` (ref order, which breaks date ties between branch tips).
    /// `exact`: explores the whole history before the first row, so dates are never trusted.
    pub fn new(dag: &mut dyn Dag, tips: &[Node], exact: bool) -> Result<Self, YagguiError> {
        let mut walk = Self {
            flags: Vec::new(),
            indegree: Vec::new(),
            row_of: Vec::new(),
            order: Vec::new(),
            explore: BinaryHeap::new(),
            unexplored_dates: BinaryHeap::new(),
            stack: Vec::new(),
            deferred: BinaryHeap::new(),
            key: Vec::new(),
            exact,
            discovered: 0,
            done: false,
            broken: false,
            parents: Vec::new(),
        };
        let mut roots: Vec<Node> = Vec::with_capacity(tips.len());
        for &tip in tips {
            if walk.flag(tip, DISCOVERED) {
                continue;
            }
            if walk.discover(dag, tip, None)? {
                roots.push(tip);
            }
        }
        // Stable: equal dates keep the ref order. Tips that turn out to have children are
        // skipped when popped, which leaves the others in the same relative order.
        roots.sort_by_key(|&node| std::cmp::Reverse(dag.time(node)));
        walk.stack = roots.into_iter().rev().collect();
        if exact {
            while let Some((_, _, node)) = walk.explore.pop() {
                walk.explore_node(dag, node)?;
            }
        }
        Ok(walk)
    }

    /// Rows emitted so far.
    pub fn rows(&self) -> u32 {
        self.order.len() as u32
    }

    /// Lower bound of the final number of rows (exact once `is_done`).
    pub fn total_estimate(&self) -> u32 {
        self.discovered
    }

    pub fn node(&self, row: u32) -> Option<Node> {
        self.order.get(row as usize).copied()
    }

    pub fn row(&self, node: Node) -> Option<u32> {
        self.row_of
            .get(node as usize)
            .copied()
            .filter(|&row| row != NO_ROW)
    }

    /// Whether `node` is (or will be) a row: reached from a tip and present.
    pub fn is_reached(&self, node: Node) -> bool {
        self.flags
            .get(node as usize)
            .is_some_and(|&f| f & (DISCOVERED | MISSING) == DISCOVERED)
    }

    /// Every reachable commit is a row.
    pub fn is_done(&self) -> bool {
        self.done
    }

    /// A child was found after its parent was emitted: the order is not topological, the
    /// walk stopped and the graph must be rebuilt with `exact`.
    pub fn is_broken(&self) -> bool {
        self.broken
    }

    /// Whether more rows can come.
    pub fn is_finished(&self) -> bool {
        self.done || self.broken
    }

    /// Emits rows until there are `rows` of them or the walk is finished.
    pub fn ensure(&mut self, dag: &mut dyn Dag, rows: u32) -> Result<(), YagguiError> {
        while self.rows() < rows && self.next(dag)?.is_some() {}
        Ok(())
    }

    /// Emits the next row.
    pub fn next(&mut self, dag: &mut dyn Dag) -> Result<Option<Node>, YagguiError> {
        if self.is_finished() {
            return Ok(None);
        }
        loop {
            self.release_deferred(dag)?;
            let Some(node) = self.stack.pop() else {
                self.done = true;
                return Ok(None);
            };
            if self.row(node).is_some() {
                continue;
            }
            self.explore_to(dag, node)?;
            if self.indegree[node as usize] > 0 {
                continue;
            }
            self.explore_node(dag, node)?;
            if self.broken {
                return Ok(None);
            }
            self.row_of[node as usize] = self.order.len() as u32;
            self.order.push(node);
            let mut parents = std::mem::take(&mut self.parents);
            dag.parents_into(node, &mut parents);
            dedup_in_order(&mut parents);
            for &parent in &parents {
                if !self.is_reached(parent) {
                    continue;
                }
                let p = parent as usize;
                self.indegree[p] -= 1;
                // Exploring only adds children: a parent still waiting for one stays.
                if self.indegree[p] > 0 {
                    continue;
                }
                let parent_time = dag.time(parent);
                if !self.exact
                    && dag.generation(parent) == GENERATION_INFINITY
                    && self.far_behind(parent_time)
                {
                    // Knowing whether it has other children means reading the whole history
                    // between the two dates: wait until the walk gets there.
                    self.deferred.push((parent_time, parent));
                    continue;
                }
                self.explore_to(dag, parent)?;
                if self.indegree[p] == 0 {
                    self.stack.push(parent);
                }
            }
            self.parents = parents;
            return Ok(Some(node));
        }
    }

    /// Whether commits without generation number dated more than `DEFER_WINDOW` after
    /// `time` are still unexplored: exploring down to `time` would read all of them. Dates,
    /// not keys: a commit's own lifted ancestors (after a dormant period) do not count.
    fn far_behind(&mut self, time: i64) -> bool {
        while let Some(&(newest, node)) = self.unexplored_dates.peek() {
            if self.flag(node, EXPLORED) {
                self.unexplored_dates.pop();
                continue;
            }
            return newest.saturating_sub(time) > DEFER_WINDOW;
        }
        false
    }

    /// Moves to the stack the deferred commits the exploration got close to (the newest one
    /// anyway when nothing else is left), once they turn out to have no other child.
    fn release_deferred(&mut self, dag: &mut dyn Dag) -> Result<(), YagguiError> {
        let mut released = Vec::new();
        while let Some(&(time, node)) = self.deferred.peek() {
            if self.far_behind(time) && !(self.stack.is_empty() && released.is_empty()) {
                break;
            }
            self.deferred.pop();
            if self.row(node).is_some() || self.indegree[node as usize] > 0 {
                continue;
            }
            self.explore_to(dag, node)?;
            if self.indegree[node as usize] == 0 {
                released.push(node);
            }
        }
        // Newest on top.
        self.stack.extend(released.into_iter().rev());
        Ok(())
    }

    fn flag(&self, node: Node, flag: u8) -> bool {
        self.flags
            .get(node as usize)
            .is_some_and(|&f| f & flag != 0)
    }

    fn grow(&mut self, len: usize) {
        if len > self.flags.len() {
            self.flags.resize(len, 0);
            self.indegree.resize(len, 0);
            self.row_of.resize(len, NO_ROW);
            self.key.resize(len, 0);
        }
    }

    /// Marks `node` reached from `child` (its key, its date, whether `node` is its first
    /// parent), reading it. `false` when its object is missing.
    fn discover(
        &mut self,
        dag: &mut dyn Dag,
        node: Node,
        child: Option<(i64, i64, bool)>,
    ) -> Result<bool, YagguiError> {
        self.grow(dag.node_count().max(node as usize + 1));
        let i = node as usize;
        if self.flags[i] & DISCOVERED != 0 {
            return Ok(self.flags[i] & MISSING == 0);
        }
        let present = dag.load(node)?;
        self.grow(dag.node_count());
        self.flags[i] |= DISCOVERED;
        if !present {
            self.flags[i] |= MISSING;
            return Ok(false);
        }
        self.discovered += 1;
        let time = dag.time(node);
        // A commit dated long before its child may have a wrong clock: explore it, and the
        // first parents after it (a series made on the same machine), close to the child's
        // date. Only first parents carry the lift on, so merges do not spread it.
        let key = match child {
            Some((key, _, true)) => time.max(key.saturating_sub(LIFT_STEP)),
            Some((_, child_time, false)) => time.max(child_time.saturating_sub(LIFT_STEP)),
            None => time,
        };
        self.key[i] = key;
        let generation = dag.generation(node);
        self.explore.push((generation, key, node));
        if generation == GENERATION_INFINITY {
            self.unexplored_dates.push((time, node));
        }
        Ok(true)
    }

    /// Counts `node` as a child of each of its parents.
    fn explore_node(&mut self, dag: &mut dyn Dag, node: Node) -> Result<(), YagguiError> {
        let i = node as usize;
        if self.flags[i] & EXPLORED != 0 {
            return Ok(());
        }
        self.flags[i] |= EXPLORED;
        let (key, time) = (self.key[i], dag.time(node));
        let mut parents = std::mem::take(&mut self.parents);
        dag.parents_into(node, &mut parents);
        dedup_in_order(&mut parents);
        for (index, &parent) in parents.iter().enumerate() {
            if !self.discover(dag, parent, Some((key, time, index == 0)))? {
                continue;
            }
            let p = parent as usize;
            self.indegree[p] += 1;
            if self.row_of[p] != NO_ROW {
                self.broken = true;
            }
        }
        self.parents = parents;
        Ok(())
    }

    /// Explores every commit that may still be an unexplored descendant of `node`, so its
    /// in-degree is final.
    fn explore_to(&mut self, dag: &mut dyn Dag, node: Node) -> Result<(), YagguiError> {
        let generation = dag.generation(node);
        let time = dag.time(node);
        while let Some(&(top_generation, top_time, top)) = self.explore.peek() {
            if self.flag(top, EXPLORED) {
                self.explore.pop();
                continue;
            }
            let may_descend = if generation != GENERATION_INFINITY {
                // Commit-graph commits only have commit-graph parents: any commit outside it
                // (infinite generation) may be a descendant.
                top_generation >= generation
            } else {
                top_generation == GENERATION_INFINITY && top_time.saturating_add(DATE_SLOP) >= time
            };
            if !may_descend {
                break;
            }
            self.explore.pop();
            self.explore_node(dag, top)?;
        }
        Ok(())
    }
}

/// Removes repeated parents (`git merge A A`), keeping the first occurrence.
pub fn dedup_in_order(nodes: &mut Vec<Node>) {
    if nodes.len() < 2 {
        return;
    }
    let mut i = 1;
    while i < nodes.len() {
        if nodes[..i].contains(&nodes[i]) {
            nodes.remove(i);
        } else {
            i += 1;
        }
    }
}

/// The order of a full sort (reachability first, then Kahn), as computed before M5-4: the
/// reference of the tests.
pub fn full_order(dag: &mut dyn Dag, tips: &[Node]) -> Result<Vec<Node>, YagguiError> {
    let mut reach: Vec<bool> = Vec::new();
    let mut stack: Vec<Node> = tips.to_vec();
    let mut parents = Vec::new();
    while let Some(node) = stack.pop() {
        let i = node as usize;
        if reach.get(i).copied().unwrap_or(false) {
            continue;
        }
        if !dag.load(node)? {
            continue;
        }
        reach.resize(reach.len().max(dag.node_count()).max(i + 1), false);
        reach[i] = true;
        dag.parents_into(node, &mut parents);
        stack.extend(&parents);
    }
    let len = dag.node_count();
    reach.resize(len, false);
    let mut indegree = vec![0u32; len];
    for node in 0..len {
        if !reach[node] {
            continue;
        }
        dag.parents_into(node as Node, &mut parents);
        dedup_in_order(&mut parents);
        for &p in &parents {
            if reach[p as usize] {
                indegree[p as usize] += 1;
            }
        }
    }
    let mut roots: Vec<Node> = Vec::new();
    let mut queued = vec![false; len];
    for &tip in tips {
        let i = tip as usize;
        if i < len && reach[i] && indegree[i] == 0 && !queued[i] {
            queued[i] = true;
            roots.push(tip);
        }
    }
    roots.sort_by_key(|&node| std::cmp::Reverse(dag.time(node)));
    let mut stack: Vec<Node> = roots.into_iter().rev().collect();
    let mut order = Vec::new();
    while let Some(node) = stack.pop() {
        order.push(node);
        dag.parents_into(node, &mut parents);
        dedup_in_order(&mut parents);
        for &p in &parents {
            let i = p as usize;
            if !reach[i] {
                continue;
            }
            indegree[i] -= 1;
            if indegree[i] == 0 {
                stack.push(p);
            }
        }
    }
    Ok(order)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A generated history. Node `i`'s parents are older nodes (`> i`), so node numbers are a
    /// topological order; the walk does not know it.
    #[derive(Clone)]
    struct TestDag {
        parents: Vec<Vec<Node>>,
        times: Vec<i64>,
        generations: Option<Vec<u32>>,
        missing: Vec<bool>,
    }

    impl Dag for TestDag {
        fn node_count(&self) -> usize {
            self.parents.len()
        }

        fn load(&mut self, node: Node) -> Result<bool, YagguiError> {
            Ok(!self.missing[node as usize])
        }

        fn parents_into(&self, node: Node, out: &mut Vec<Node>) {
            out.clear();
            out.extend(&self.parents[node as usize]);
        }

        fn time(&self, node: Node) -> i64 {
            self.times[node as usize]
        }

        fn generation(&self, node: Node) -> u32 {
            self.generations
                .as_ref()
                .map_or(GENERATION_INFINITY, |g| g[node as usize])
        }
    }

    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, n: u64) -> u64 {
            self.next() % n.max(1)
        }
    }

    #[derive(Clone, Copy)]
    enum Clock {
        /// Older commits have older dates.
        Monotonic,
        /// Dates jitter by up to two hours around the monotonic ones.
        Jitter,
        /// Some commits (and runs of commits) come from a machine whose clock is years off.
        Skewed,
        /// Random dates.
        Random,
        /// Every commit at the same second (the test fixtures).
        Same,
        /// Children newer than their parents, with up to two months between commits: parents
        /// released by a much newer child are deferred.
        Sparse,
    }

    /// Branches that fork, merge into each other (criss-cross merges included), octopus
    /// merges, several roots, duplicate parents and a few missing commits.
    #[derive(Clone, Copy, PartialEq)]
    enum Generations {
        None,
        All,
        /// The newest commits are outside the commit-graph.
        Partial,
    }

    fn generate(
        seed: u64,
        size: usize,
        clock: Clock,
        generations: Generations,
    ) -> (TestDag, Vec<Node>) {
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
        let n = size;
        let mut parents: Vec<Vec<Node>> = vec![Vec::new(); n];
        for (i, list) in parents.iter_mut().enumerate() {
            let left = (n - i - 1) as u64;
            if left == 0 || rng.below(60) == 0 {
                continue;
            }
            // Mostly near parents (a branch), sometimes far ones (an old base).
            let pick = |rng: &mut Rng| {
                let span = if rng.below(8) == 0 {
                    left
                } else {
                    left.min(12)
                };
                (i as u64 + 1 + rng.below(span)) as Node
            };
            list.push(pick(&mut rng));
            let extra = match rng.below(20) {
                0..=3 => 1,
                4 => 3,
                _ => 0,
            };
            for _ in 0..extra {
                list.push(pick(&mut rng));
            }
            if rng.below(50) == 0 {
                let first = list[0];
                list.push(first);
            }
        }
        let base = 1_700_000_000i64;
        let mut times: Vec<i64> = (0..n)
            .map(|i| base - 600 * i as i64 + rng.below(300) as i64)
            .collect();
        match clock {
            Clock::Monotonic => {
                for i in (0..n.saturating_sub(1)).rev() {
                    times[i] = times[i].max(times[i + 1] + 1);
                }
                // A child is always newer than its parents.
                for i in (0..n).rev() {
                    let newest = parents[i].iter().map(|&p| times[p as usize]).max();
                    if let Some(newest) = newest {
                        times[i] = times[i].max(newest + 1);
                    }
                }
            }
            Clock::Jitter => {
                for t in &mut times {
                    *t += rng.below(4 * 3600) as i64 - 2 * 3600;
                }
            }
            Clock::Skewed => {
                let mut i = 0;
                while i < n {
                    if rng.below(25) == 0 {
                        let run = 1 + rng.below(4) as usize;
                        let offset = if rng.below(2) == 0 { -1 } else { 1 }
                            * (86_400 * (1 + rng.below(3000)) as i64);
                        for t in times.iter_mut().skip(i).take(run) {
                            *t += offset;
                        }
                        i += run;
                    }
                    i += 1;
                }
            }
            Clock::Random => {
                for t in &mut times {
                    *t = base - rng.below(86_400 * 365) as i64;
                }
            }
            Clock::Same => times.iter_mut().for_each(|t| *t = base),
            Clock::Sparse => {
                for i in (0..n.saturating_sub(1)).rev() {
                    times[i] = times[i + 1] + 1 + rng.below(60 * 86_400) as i64;
                }
                for i in (0..n).rev() {
                    let newest = parents[i].iter().map(|&p| times[p as usize]).max();
                    if let Some(newest) = newest {
                        times[i] = times[i].max(newest + 1);
                    }
                }
            }
        }
        let missing: Vec<bool> = (0..n).map(|_| rng.below(150) == 0).collect();
        let outside = rng.below(n as u64 / 4 + 1) as usize;
        let generations = (generations != Generations::None).then(|| {
            let mut g = vec![1u32; n];
            for i in (0..n).rev() {
                g[i] = 1 + parents[i].iter().map(|&p| g[p as usize]).max().unwrap_or(0);
            }
            if generations == Generations::Partial {
                g[..outside].fill(GENERATION_INFINITY);
            }
            g
        });
        // Branch tips: the newest commit, then a few random ones (some are ancestors of
        // others, like tags), possibly repeated.
        let mut tips = vec![0];
        for _ in 0..1 + rng.below(8) {
            tips.push(rng.below(n as u64) as Node);
        }
        (
            TestDag {
                parents,
                times,
                generations,
                missing,
            },
            tips,
        )
    }

    /// Every row comes after all its children that are rows.
    fn assert_topological(dag: &TestDag, order: &[Node]) {
        let mut row = vec![usize::MAX; dag.node_count()];
        for (r, &node) in order.iter().enumerate() {
            assert_eq!(row[node as usize], usize::MAX, "node {node} twice");
            row[node as usize] = r;
        }
        for (r, &node) in order.iter().enumerate() {
            for &p in &dag.parents[node as usize] {
                if row[p as usize] != usize::MAX {
                    assert!(row[p as usize] > r, "parent {p} before its child {node}");
                }
            }
        }
    }

    /// Emits by steps of `step` rows, checking that rows already emitted never change.
    fn walk_by(dag: &TestDag, tips: &[Node], exact: bool, step: u32) -> (Vec<Node>, bool) {
        let mut d = dag.clone();
        let mut walk = Walk::new(&mut d, tips, exact).unwrap();
        let mut seen: Vec<Node> = Vec::new();
        while !walk.is_finished() {
            walk.ensure(&mut d, walk.rows() + step).unwrap();
            let rows: Vec<Node> = (0..walk.rows()).filter_map(|r| walk.node(r)).collect();
            assert_eq!(&rows[..seen.len()], &seen[..], "emitted rows changed");
            assert!(walk.total_estimate() >= walk.rows());
            seen = rows;
        }
        if walk.is_done() {
            assert_eq!(walk.total_estimate(), walk.rows());
        }
        (seen, walk.is_broken())
    }

    #[test]
    fn matches_the_full_sort_with_generations() {
        for seed in 0..400 {
            for clock in [Clock::Monotonic, Clock::Skewed, Clock::Random, Clock::Same] {
                let size = 1 + (seed as usize * 7) % 300;
                let (dag, tips) = generate(seed, size, clock, Generations::All);
                let expected = full_order(&mut dag.clone(), &tips).unwrap();
                assert_topological(&dag, &expected);
                for step in [1, 7, 500] {
                    let (order, broken) = walk_by(&dag, &tips, false, step);
                    assert!(!broken, "seed {seed}");
                    assert_eq!(order, expected, "seed {seed}, step {step}");
                }
            }
        }
    }

    #[test]
    fn matches_the_full_sort_when_dates_are_consistent() {
        let cases = [Generations::None, Generations::Partial];
        for seed in 0..400 {
            for (clock, generations) in [Clock::Monotonic, Clock::Jitter, Clock::Same]
                .into_iter()
                .flat_map(|clock| cases.map(|g| (clock, g)))
            {
                let size = 1 + (seed as usize * 13) % 400;
                let (dag, tips) = generate(seed, size, clock, generations);
                let expected = full_order(&mut dag.clone(), &tips).unwrap();
                for step in [1, 13, 500] {
                    let (order, broken) = walk_by(&dag, &tips, false, step);
                    assert!(!broken, "seed {seed}");
                    assert_eq!(order, expected, "seed {seed}, step {step}");
                }
            }
        }
    }

    #[test]
    fn defers_old_parents_and_stays_topological() {
        let mut deferred = 0;
        for seed in 0..400 {
            for generations in [Generations::None, Generations::Partial] {
                let size = 1 + (seed as usize * 17) % 400;
                let (dag, tips) = generate(seed, size, Clock::Sparse, generations);
                let expected = full_order(&mut dag.clone(), &tips).unwrap();
                let mut all = expected.clone();
                all.sort_unstable();
                for step in [1, 9, 500] {
                    let (order, broken) = walk_by(&dag, &tips, false, step);
                    assert!(!broken, "seed {seed}");
                    assert_topological(&dag, &order);
                    let mut sorted = order.clone();
                    sorted.sort_unstable();
                    assert_eq!(sorted, all, "seed {seed}");
                    deferred += usize::from(order != expected);
                }
                // The full exploration defers nothing: Git's order.
                assert_eq!(walk_by(&dag, &tips, true, 7).0, expected, "seed {seed}");
            }
        }
        assert!(deferred > 0);
    }

    #[test]
    fn stays_topological_or_reports_it_with_wrong_clocks() {
        let mut broken_walks = 0;
        for seed in 0..600 {
            for clock in [Clock::Skewed, Clock::Random] {
                let size = 1 + (seed as usize * 11) % 400;
                let (dag, tips) = generate(seed, size, clock, Generations::None);
                let expected = full_order(&mut dag.clone(), &tips).unwrap();
                for step in [1, 500] {
                    let (order, broken) = walk_by(&dag, &tips, false, step);
                    if broken {
                        broken_walks += 1;
                    } else {
                        // Not always the full sort's order (a commit released too early is
                        // held back), but the same rows in a topological order.
                        assert_topological(&dag, &order);
                        let mut sorted = order.clone();
                        sorted.sort_unstable();
                        let mut all = expected.clone();
                        all.sort_unstable();
                        assert_eq!(sorted, all, "seed {seed}");
                    }
                }
                // The fallback is the full sort.
                let (order, broken) = walk_by(&dag, &tips, true, 50);
                assert!(!broken);
                assert_eq!(order, expected, "seed {seed}, exact");
            }
        }
        // Random dates defeat the heuristic now and then: the fallback must be exercised.
        assert!(broken_walks > 0);
    }

    #[test]
    fn explores_a_series_made_with_a_wrong_clock_in_time() {
        // Main line 0..100, 10 min apart. Commit 50 also has a side branch: tip 100, then
        // 101..=103 dated 200 days too early, then 50. Like the linux edges that broke the
        // walk before the lift.
        let main = 100;
        let mut parents: Vec<Vec<Node>> = (0..main)
            .map(|i| {
                if i + 1 < main {
                    vec![i as Node + 1]
                } else {
                    vec![]
                }
            })
            .collect();
        let mut times: Vec<i64> = (0..main).map(|i| 2_000_000_000 - 600 * i as i64).collect();
        parents.extend([vec![101], vec![102], vec![103], vec![50]]);
        let wrong = times[50] - 200 * 86_400;
        times.extend([times[10], wrong, wrong - 60, wrong - 120]);
        let dag = TestDag {
            missing: vec![false; parents.len()],
            parents,
            times,
            generations: None,
        };
        for step in [1, 500] {
            let (order, broken) = walk_by(&dag, &[0, 100], false, step);
            assert!(!broken);
            assert_topological(&dag, &order);
            assert_eq!(order.len(), dag.node_count());
        }
    }

    #[test]
    fn keeps_git_order_after_a_dormant_period() {
        // A history untouched for two years, then a new commit on main: nothing to explore
        // between them, so nothing is deferred.
        let n = 60;
        let mut parents: Vec<Vec<Node>> = (0..n)
            .map(|i| {
                if i + 1 < n {
                    vec![i as Node + 1]
                } else {
                    vec![]
                }
            })
            .collect();
        let mut times: Vec<i64> = (0..n).map(|i| 1_700_000_000 - 600 * i as i64).collect();
        times[0] += 2 * 365 * 86_400;
        // Side branches forked from main before the pause.
        parents.extend([vec![5], vec![12]]);
        times.extend([times[3], times[9]]);
        let dag = TestDag {
            missing: vec![false; parents.len()],
            parents,
            times,
            generations: None,
        };
        let tips = [0, 60, 61];
        let expected = full_order(&mut dag.clone(), &tips).unwrap();
        assert_eq!(walk_by(&dag, &tips, false, 1).0, expected);
    }

    #[test]
    fn explores_lazily() {
        // A long linear history with monotonic dates: the first rows need only a little more
        // than themselves.
        let n = 100_000;
        let dag = TestDag {
            parents: (0..n)
                .map(|i| {
                    if i + 1 < n {
                        vec![i as Node + 1]
                    } else {
                        vec![]
                    }
                })
                .collect(),
            times: (0..n).map(|i| 2_000_000_000 - 600 * i as i64).collect(),
            generations: None,
            missing: vec![false; n],
        };
        let mut d = dag.clone();
        let mut walk = Walk::new(&mut d, &[0], false).unwrap();
        walk.ensure(&mut d, 501).unwrap();
        assert_eq!(walk.rows(), 501);
        // 24 h of slop at one commit every 10 min.
        assert!(
            walk.total_estimate() < 501 + 200,
            "{}",
            walk.total_estimate()
        );
        walk.ensure(&mut d, u32::MAX).unwrap();
        assert!(walk.is_done());
        assert_eq!(walk.rows(), n as u32);
    }

    #[test]
    fn dedups_parents() {
        let mut nodes = vec![3, 1, 3, 2, 1];
        dedup_in_order(&mut nodes);
        assert_eq!(nodes, vec![3, 1, 2]);
    }
}
