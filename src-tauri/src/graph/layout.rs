//! Lane layout, computed page by page from checkpoints.
//!
//! Walking the rows in order, each lane leads to the commit it "expects". A commit takes the
//! leftmost lane expecting it (or the lowest free lane for a branch tip); its first parent
//! continues on that lane, other parents join a lane already expecting them or open a new
//! one. Lanes are freed as soon as their commit is reached and reused from the left.
//! The frontend's mock runs the same algorithm (`src/ipc/mockLayout.ts`).

use super::types::{GRAPH_COLORS, GRAPH_MAX_LANES, edge_kind};

/// Rows between two saved layout states.
const CHECKPOINT_EVERY: u32 = 500;

/// What the layout needs to know about the rows. Lanes lead to commits (`u32` node ids), not
/// rows: the parents of a row may not have a row yet when it is laid out (M5-4).
pub trait RowSource {
    /// Commit of `row`, `None` past the last row. Rows asked for are already known.
    fn node(&self, row: u32) -> Option<u32>;
    /// Parents of `node` that are rows (or will be), first parent first, deduplicated.
    fn parents(&self, node: u32, out: &mut Vec<u32>);
    /// Preferred color of a lane starting at `node`, see `color_hash`.
    fn seed_color(&self, node: u32) -> u32;
}

/// FNV-1a of a branch name or SHA, reduced to a color index: a branch keeps its color across
/// pages and refreshes.
pub fn color_hash(seed: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for &byte in seed {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash % GRAPH_COLORS
}

#[derive(Debug, Clone)]
struct Slot {
    /// Commit this lane leads to.
    expects: u32,
    color: u32,
    /// Lane, at the height of the current row, the line comes from.
    top: u32,
    kind: u32,
    wip: bool,
}

/// A line from a node to a lane that already expected the same parent.
#[derive(Debug, Clone)]
struct Extra {
    top: u32,
    lane: u32,
    expects: u32,
    color: u32,
    kind: u32,
}

/// Lines pending below the previous row, i.e. the layout state before a row.
#[derive(Debug, Clone, Default)]
struct State {
    slots: Vec<Option<Slot>>,
    extras: Vec<Extra>,
}

impl State {
    fn lowest_free(&self) -> u32 {
        self.slots
            .iter()
            .position(Option::is_none)
            .unwrap_or(self.slots.len()) as u32
    }

    fn lane_expecting(&self, node: u32) -> Option<u32> {
        self.slots
            .iter()
            .position(|slot| slot.as_ref().is_some_and(|s| s.expects == node))
            .map(|lane| lane as u32)
    }

    fn color_at(&self, lane: i64) -> Option<u32> {
        let lane = usize::try_from(lane).ok()?;
        self.slots.get(lane)?.as_ref().map(|s| s.color)
    }

    /// The preferred color, shifted when a neighbor lane already uses it.
    fn pick_color(&self, preferred: u32, lane: u32) -> u32 {
        let lane = i64::from(lane);
        (0..GRAPH_COLORS)
            .map(|shift| (preferred + shift) % GRAPH_COLORS)
            .find(|&c| self.color_at(lane - 1) != Some(c) && self.color_at(lane + 1) != Some(c))
            .unwrap_or(preferred)
    }

    fn set(&mut self, lane: u32, slot: Slot) {
        let lane = lane as usize;
        if lane >= self.slots.len() {
            self.slots.resize(lane + 1, None);
        }
        self.slots[lane] = Some(slot);
    }
}

/// Layout of rows `start..end`, in the shape of `GraphPage`.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct LayoutRows {
    pub lanes: Vec<u32>,
    pub colors: Vec<u32>,
    pub edge_offsets: Vec<u32>,
    pub edges: Vec<u32>,
    pub lane_count: u32,
}

/// Lane and color of the WIP line, and the commit it leads to (HEAD's).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WipLane {
    pub lane: u32,
    pub color: u32,
    pub head: u32,
}

/// Incremental layout of one graph version.
pub struct Layout {
    /// `checkpoints[k]` is the state before row `k * CHECKPOINT_EVERY`.
    checkpoints: Vec<State>,
    wip: Option<WipLane>,
}

fn cap(lane: u32) -> u32 {
    lane.min(GRAPH_MAX_LANES - 1)
}

impl Layout {
    /// `head`: HEAD's commit and its color, to reserve the WIP lane above row 0.
    pub fn new(head: Option<(u32, u32)>) -> Self {
        let mut initial = State::default();
        let wip = head.map(|(head, color)| {
            initial.set(
                0,
                Slot {
                    expects: head,
                    color,
                    top: 0,
                    kind: edge_kind::WIP,
                    wip: true,
                },
            );
            WipLane {
                lane: 0,
                color,
                head,
            }
        });
        Self {
            checkpoints: vec![initial],
            wip,
        }
    }

    pub fn wip(&self) -> Option<WipLane> {
        self.wip
    }

    /// Lays out rows `start..end`, resuming from the closest checkpoint; checkpoints up to
    /// `start` are computed and kept on the way. Rows `..=end` must be known to `source`
    /// (`node(end)` is `None` when `end` is past the last row).
    pub fn rows(&mut self, source: &dyn RowSource, start: u32, end: u32) -> LayoutRows {
        let start = start.min(end);
        let mut parents = Vec::new();
        let wanted = (start / CHECKPOINT_EVERY) as usize;
        while self.checkpoints.len() <= wanted {
            let k = self.checkpoints.len() - 1;
            let mut state = self.checkpoints[k].clone();
            let from = k as u32 * CHECKPOINT_EVERY;
            for row in from..from + CHECKPOINT_EVERY {
                if let Some(node) = source.node(row) {
                    advance(&mut state, source, node, &mut parents);
                }
            }
            self.checkpoints.push(state);
        }

        let mut state = self.checkpoints[wanted].clone();
        let mut out = LayoutRows::default();
        for row in wanted as u32 * CHECKPOINT_EVERY..=end {
            // The edges of `row - 1` depend on the lane of `row`'s node.
            if row > start {
                emit(&state, source, source.node(row), &mut out);
            }
            if row == end {
                break;
            }
            let Some(node) = source.node(row) else { break };
            if row >= start {
                let (lane, color) = node_lane(&state, source, node);
                out.lanes.push(cap(lane));
                out.colors.push(color);
            }
            advance(&mut state, source, node, &mut parents);
        }
        out.edge_offsets.push((out.edges.len() / 4) as u32);
        out.lane_count = out
            .lanes
            .iter()
            .chain(out.edges.as_chunks::<4>().0.iter().flat_map(|e| &e[..2]))
            .max()
            .map_or(0, |&lane| lane + 1);
        out
    }
}

/// Lane and color of the commit `node` (the next row), without changing the state.
fn node_lane(state: &State, source: &dyn RowSource, node: u32) -> (u32, u32) {
    match state.lane_expecting(node) {
        Some(lane) => {
            let color = state.slots[lane as usize].as_ref().map_or(0, |s| s.color);
            (lane, color)
        }
        None => {
            let lane = state.lowest_free();
            (lane, state.pick_color(source.seed_color(node), lane))
        }
    }
}

/// Appends the edges between the previous row and the row of `next` (pending lines of
/// `state`; `next` is `None` after the last row).
fn emit(state: &State, source: &dyn RowSource, next: Option<u32>, out: &mut LayoutRows) {
    let node = next.map(|next| (next, node_lane(state, source, next).0));
    out.edge_offsets.push((out.edges.len() / 4) as u32);
    let row_start = out.edges.len();
    let push = |from: u32, to: u32, color: u32, kind: u32, edges: &mut Vec<u32>| {
        let (a, b) = (cap(from), cap(to));
        if (a != from || b != to)
            && edges[row_start..]
                .as_chunks::<4>()
                .0
                .iter()
                .any(|e| e[0] == a && e[1] == b && e[2] == color)
        {
            return;
        }
        edges.extend_from_slice(&[a, b, color, kind]);
    };
    let target = |expects: u32, lane: u32| match node {
        Some((next, node_lane)) if expects == next => node_lane,
        _ => lane,
    };
    for (lane, slot) in state.slots.iter().enumerate() {
        if let Some(s) = slot {
            push(
                s.top,
                target(s.expects, lane as u32),
                s.color,
                s.kind,
                &mut out.edges,
            );
        }
    }
    for e in &state.extras {
        push(
            e.top,
            target(e.expects, e.lane),
            e.color,
            e.kind,
            &mut out.edges,
        );
    }
}

/// Moves past the row of `node`: its lane is released and its parents get theirs.
fn advance(state: &mut State, source: &dyn RowSource, node: u32, parents: &mut Vec<u32>) {
    let (lane, color) = node_lane(state, source, node);
    for (k, slot) in state.slots.iter_mut().enumerate() {
        let Some(s) = slot else { continue };
        if s.expects == node {
            *slot = None;
        } else {
            s.top = k as u32;
            s.kind = if s.wip {
                edge_kind::WIP
            } else {
                edge_kind::NORMAL
            };
        }
    }
    state.extras.clear();

    source.parents(node, parents);
    for (index, &parent) in parents.iter().enumerate() {
        if index == 0 {
            // The first parent always continues on the node's lane, even when another lane
            // already leads to it: both lanes then join on the parent's row.
            state.set(
                lane,
                Slot {
                    expects: parent,
                    color,
                    top: lane,
                    kind: edge_kind::NORMAL,
                    wip: false,
                },
            );
            continue;
        }
        if let Some(existing) = state.lane_expecting(parent) {
            let existing_color = state.slots[existing as usize]
                .as_ref()
                .map_or(0, |s| s.color);
            state.extras.push(Extra {
                top: lane,
                lane: existing,
                expects: parent,
                color: existing_color,
                kind: edge_kind::MERGE,
            });
        } else {
            let target = state.lowest_free();
            let color = state.pick_color(source.seed_color(parent), target);
            state.set(
                target,
                Slot {
                    expects: parent,
                    color,
                    top: lane,
                    kind: edge_kind::MERGE,
                    wip: false,
                },
            );
        }
    }
    while state.slots.last().is_some_and(Option::is_none) {
        state.slots.pop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A random DAG: each row has 1 to 3 parents among the next rows, some roots.
    struct Random {
        parents: Vec<Vec<u32>>,
    }

    impl Random {
        fn new(rows: u32, mut seed: u64) -> Self {
            let mut next = move || {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                seed
            };
            let parents = (0..rows)
                .map(|row| {
                    let left = rows - row - 1;
                    if left == 0 || next() % 50 == 0 {
                        return Vec::new();
                    }
                    let count = 1 + (next() % 10 == 0) as u64 + (next() % 40 == 0) as u64;
                    let mut out: Vec<u32> = (0..count)
                        .map(|_| row + 1 + (next() % u64::from(left.min(30))) as u32)
                        .collect();
                    out.dedup();
                    out
                })
                .collect();
            Self { parents }
        }
    }

    /// Rows are the nodes themselves.
    impl RowSource for Random {
        fn node(&self, row: u32) -> Option<u32> {
            ((row as usize) < self.parents.len()).then_some(row)
        }

        fn parents(&self, node: u32, out: &mut Vec<u32>) {
            out.clear();
            out.extend(&self.parents[node as usize]);
        }

        fn seed_color(&self, node: u32) -> u32 {
            color_hash(&node.to_le_bytes())
        }
    }

    #[test]
    fn pages_match_the_whole_layout() {
        let rows = 1_750;
        let source = Random::new(rows, 0x9e37_79b9_7f4a_7c15);
        let whole = Layout::new(Some((3, 2))).rows(&source, 0, rows);
        assert_eq!(whole.lanes.len(), rows as usize);
        for size in [1, 7, 500, 499] {
            let mut layout = Layout::new(Some((3, 2)));
            let mut start = 0;
            // Jump around, so checkpoints are reused out of order.
            let mut starts: Vec<u32> = (0..rows).step_by(size).collect();
            starts.reverse();
            for &s in &starts {
                let part = layout.rows(&source, s, (s + size as u32).min(rows));
                let end = (s + size as u32).min(rows) as usize;
                assert_eq!(part.lanes, whole.lanes[s as usize..end]);
                let base = whole.edge_offsets[s as usize];
                let edges = &whole.edges[4 * base as usize..4 * whole.edge_offsets[end] as usize];
                assert_eq!(part.edges, edges, "page {s} of {size}");
                start += 1;
            }
            assert_eq!(start, starts.len());
        }
    }

    #[test]
    fn lanes_are_capped() {
        // 100 tips all merging into the last row.
        let rows = 101;
        let source = Random {
            parents: (0..rows)
                .map(|r| if r < 100 { vec![100] } else { vec![] })
                .collect(),
        };
        let out = Layout::new(None).rows(&source, 0, rows);
        assert_eq!(out.lane_count, GRAPH_MAX_LANES);
        assert!(out.lanes.iter().all(|&l| l < GRAPH_MAX_LANES));
        assert!(
            out.edges
                .as_chunks::<4>()
                .0
                .iter()
                .all(|e| e[0] < GRAPH_MAX_LANES && e[1] < GRAPH_MAX_LANES)
        );
    }
}
