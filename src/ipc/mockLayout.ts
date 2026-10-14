import { EDGE_MERGE, EDGE_NORMAL, EDGE_WIP, GRAPH_COLORS, GRAPH_MAX_LANES } from './bindings';

/**
 * Lane layout of the mock backend. Same algorithm as `src-tauri/src/graph/layout.rs`, on the
 * whole graph at once (the Rust side computes it page by page from checkpoints).
 */
export interface GraphLayout {
  /** Lane of the node of each row (capped). */
  lanes: Int32Array;
  colors: Int32Array;
  /** Row `r` edges are `edges[4 * edgeOffsets[r] .. 4 * edgeOffsets[r + 1]]`. */
  edgeOffsets: Int32Array;
  edges: number[];
  wip: { lane: number; color: number; headRow: number } | null;
}

interface Slot {
  /** Row of the commit this lane leads to. */
  expects: number;
  color: number;
  /** Lane at the height of the current row the line comes from. */
  top: number;
  kind: number;
  wip: boolean;
}

interface Extra {
  top: number;
  lane: number;
  expects: number;
  color: number;
  kind: number;
}

/** FNV-1a, the hash the backend uses to derive a stable color from a branch name or SHA. */
export function colorHash(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % GRAPH_COLORS;
}

function lowestFree(slots: (Slot | null)[]): number {
  const index = slots.indexOf(null);
  return index < 0 ? slots.length : index;
}

/** Lane already leading to `row`, or -1. A plain loop: this runs for each of 100k rows. */
function laneExpecting(slots: (Slot | null)[], row: number): number {
  for (let k = 0; k < slots.length; k++) if (slots[k]?.expects === row) return k;
  return -1;
}

/** Color from the seed, shifted when a neighbor lane already uses it. */
function pickColor(seed: string, lane: number, slots: (Slot | null)[]): number {
  const base = colorHash(seed);
  for (let shift = 0; shift < GRAPH_COLORS; shift++) {
    const candidate = (base + shift) % GRAPH_COLORS;
    if (slots[lane - 1]?.color !== candidate && slots[lane + 1]?.color !== candidate) {
      return candidate;
    }
  }
  return base;
}

const cap = (lane: number) => Math.min(lane, GRAPH_MAX_LANES - 1);

/** Appends an edge to the current row (starting at `rowStart`); capped duplicates merge. */
function emitEdge(
  edges: number[],
  rowStart: number,
  from: number,
  to: number,
  color: number,
  kind: number,
) {
  const a = cap(from);
  const b = cap(to);
  if (from !== a || to !== b) {
    for (let i = rowStart; i < edges.length; i += 4) {
      if (edges[i] === a && edges[i + 1] === b && edges[i + 2] === color) return;
    }
  }
  edges.push(a, b, color, kind);
}

/**
 * `parentRows[r]`: rows of the parents of row `r` (all greater than `r`), first parent first.
 * `seeds[r]`: name the color of a lane starting at row `r` derives from (branch name or SHA).
 */
export function computeLayout(
  parentRows: readonly (readonly number[])[],
  seeds: readonly string[],
  headRow: number | null,
  headSeed: string,
): GraphLayout {
  const n = parentRows.length;
  const lanes = new Int32Array(n);
  const colors = new Int32Array(n);
  const edgeOffsets = new Int32Array(n + 1);
  const edges: number[] = [];
  const slots: (Slot | null)[] = [];
  let extras: Extra[] = [];
  let wip: GraphLayout['wip'] = null;

  if (headRow !== null) {
    const color = colorHash(headSeed);
    slots.push({ expects: headRow, color, top: 0, kind: EDGE_WIP, wip: true });
    wip = { lane: 0, color, headRow };
  }

  for (let row = 0; row <= n; row++) {
    let lane = -1;
    let color = 0;
    if (row < n) {
      lane = laneExpecting(slots, row);
      if (lane < 0) {
        lane = lowestFree(slots);
        color = pickColor(seeds[row] ?? '', lane, slots);
      } else {
        color = slots[lane]?.color ?? 0;
      }
    }

    if (row > 0) {
      edgeOffsets[row - 1] = edges.length / 4;
      const rowStart = edges.length;
      for (let k = 0; k < slots.length; k++) {
        const slot = slots[k];
        if (slot) {
          emitEdge(
            edges,
            rowStart,
            slot.top,
            slot.expects === row ? lane : k,
            slot.color,
            slot.kind,
          );
        }
      }
      for (const extra of extras) {
        emitEdge(
          edges,
          rowStart,
          extra.top,
          extra.expects === row ? lane : extra.lane,
          extra.color,
          extra.kind,
        );
      }
    }
    if (row === n) break;

    lanes[row] = cap(lane);
    colors[row] = color;

    for (let k = 0; k < slots.length; k++) {
      const slot = slots[k];
      if (!slot) continue;
      if (slot.expects === row) {
        slots[k] = null;
      } else {
        slot.top = k;
        slot.kind = slot.wip ? EDGE_WIP : EDGE_NORMAL;
      }
    }
    if (extras.length > 0) extras = [];

    const parents = parentRows[row] ?? [];
    parents.forEach((parent, index) => {
      // Duplicated parents are drawn once (`indexOf` is cheap on a handful of parents).
      if (parents.indexOf(parent) !== index) return;
      if (index === 0) {
        // The first parent always continues on the node's lane, even when another lane
        // already leads to it: both lanes then join on the parent's row.
        slots[lane] = { expects: parent, color, top: lane, kind: EDGE_NORMAL, wip: false };
        return;
      }
      const existing = laneExpecting(slots, parent);
      const existingSlot = slots[existing];
      if (existingSlot) {
        extras.push({
          top: lane,
          lane: existing,
          expects: parent,
          color: existingSlot.color,
          kind: EDGE_MERGE,
        });
      } else {
        const target = lowestFree(slots);
        slots[target] = {
          expects: parent,
          color: pickColor(seeds[parent] ?? '', target, slots),
          top: lane,
          kind: EDGE_MERGE,
          wip: false,
        };
      }
    });
    while (slots.length > 0 && slots[slots.length - 1] === null) slots.pop();
  }
  edgeOffsets[n] = edges.length / 4;
  return { lanes, colors, edgeOffsets, edges, wip };
}
