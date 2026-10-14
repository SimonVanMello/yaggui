import { EDGE_WIP, type GraphWip } from '../../ipc';
import { laneX } from './geometry';
import type { GraphRow, RowEdges } from './pageCache';

/** A line between two row centers; drawn straight when vertical, as an S-curve otherwise. */
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: number;
  dashed: boolean;
}

export interface SceneNode {
  x: number;
  y: number;
  color: number;
  kind: 'commit' | 'merge' | 'wip';
  head: boolean;
  selected: boolean;
}

export interface GraphScene {
  segments: Segment[];
  nodes: SceneNode[];
}

export interface SceneInput {
  /** Rows to draw (inclusive); edges of `first - 1` are included for the top half row. */
  first: number;
  last: number;
  rowHeight: number;
  /** Height of the WIP row above row 0 (0 when it is hidden). */
  wipHeight: number;
  /** Logical y of the canvas top: every y is relative to it. */
  top: number;
  rowAt: (row: number) => GraphRow | undefined;
  edgesAt: (row: number) => RowEdges | undefined;
  wip: GraphWip | null;
  selectedRow: number | null;
  wipSelected: boolean;
}

export function rowCenter(row: number, rowHeight: number, wipHeight: number): number {
  return wipHeight + row * rowHeight + rowHeight / 2;
}

/**
 * Lines and nodes of a range of rows, from the backend layout only (no layout logic here).
 * The WIP node and its dashed line are part of the scene only while the WIP row is shown.
 */
export function buildScene(input: SceneInput): GraphScene {
  const { first, last, rowHeight, wipHeight, top, wip } = input;
  const showWip = wipHeight > 0;
  const y = (row: number) => rowCenter(row, rowHeight, wipHeight) - top;
  const segments: Segment[] = [];
  const nodes: SceneNode[] = [];

  for (let row = Math.max(0, first - 1); row <= last; row++) {
    const rowEdges = input.edgesAt(row);
    if (!rowEdges) continue;
    const { edges, from, to } = rowEdges;
    const y1 = y(row);
    const y2 = y(row + 1);
    for (let i = from; i < to; i++) {
      const fromLane = edges[4 * i] ?? 0;
      const toLane = edges[4 * i + 1] ?? 0;
      const color = edges[4 * i + 2] ?? 0;
      const kind = edges[4 * i + 3] ?? 0;
      if (kind === EDGE_WIP && !showWip) continue;
      segments.push({
        x1: laneX(fromLane),
        y1,
        x2: laneX(toLane),
        y2,
        color,
        dashed: kind === EDGE_WIP,
      });
    }
  }

  if (showWip && first === 0) {
    const lane = wip?.lane ?? 0;
    const color = wip?.color ?? 0;
    const wipY = wipHeight / 2 - top;
    // The backend has no edge above row 0: the WIP node joins its line here.
    if (wip) {
      segments.push({ x1: laneX(lane), y1: wipY, x2: laneX(lane), y2: y(0), color, dashed: true });
    }
    nodes.push({
      x: laneX(lane),
      y: wipY,
      color,
      kind: 'wip',
      head: false,
      selected: input.wipSelected,
    });
  }

  for (let row = first; row <= last; row++) {
    const data = input.rowAt(row);
    if (!data) continue;
    nodes.push({
      x: laneX(data.lane),
      y: y(row),
      color: data.color,
      kind: data.parents.length > 1 ? 'merge' : 'commit',
      head: wip?.headRow === row,
      selected: input.selectedRow === row,
    });
  }
  return { segments, nodes };
}
