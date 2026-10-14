import { describe, expect, it, vi } from 'vitest';

import { EDGE_WIP, type GraphPage } from '../../ipc';
import { computeLayout } from '../../ipc/mockLayout';
import { drawScene, type GraphContext } from './drawGraph';
import { laneX } from './geometry';
import { GraphPageCache } from './pageCache';
import { buildScene, rowCenter, type SceneInput } from './scene';

const RH = 28;

/**
 * Rows: 0 = feature tip (HEAD's parent is row 1), 1 = main tip, 2 = merge-base…
 *   0 ─┐
 *   1  │   (main)
 *   2 ─┘   fork point
 *   3      root
 */
function cacheFor(parentRows: number[][], headRow: number | null): GraphPageCache {
  const layout = computeLayout(
    parentRows,
    parentRows.map((_, r) => `seed${String(r)}`),
    headRow,
    'head',
  );
  const n = parentRows.length;
  const page: GraphPage = {
    version: 1,
    start: 0,
    totalRows: n,
    totalExact: true,
    laneCount: 3,
    wip: layout.wip,
    shas: parentRows.map((_, r) => `s${String(r)}`),
    parents: parentRows.map((ps) => ps.map((p) => `s${String(p)}`)),
    summaries: parentRows.map(() => ''),
    authorNames: parentRows.map(() => ''),
    authorEmails: parentRows.map(() => ''),
    authorTimes: parentRows.map(() => null),
    commitTimes: parentRows.map(() => null),
    lanes: Array.from(layout.lanes),
    colors: Array.from(layout.colors),
    signatures: parentRows.map(() => 0),
    edgeOffsets: Array.from(layout.edgeOffsets),
    edges: layout.edges,
    refs: [],
  };
  const cache = new GraphPageCache(() => Promise.reject(new Error('unused')));
  cache.insert(page);
  return cache;
}

function input(cache: GraphPageCache, patch: Partial<SceneInput> = {}): SceneInput {
  return {
    first: 0,
    last: cache.totalRows - 1,
    rowHeight: RH,
    wipHeight: RH,
    top: 0,
    rowAt: (r) => cache.row(r),
    edgesAt: (r) => cache.edgesOf(r),
    wip: cache.wip,
    selectedRow: null,
    wipSelected: false,
    ...patch,
  };
}

const HISTORY = [[2], [2], [3], []];

describe('buildScene', () => {
  it('draws one node per row on its lane, the merge-base as a plain commit', () => {
    const cache = cacheFor(HISTORY, 0);
    const scene = buildScene(input(cache));
    const commits = scene.nodes.filter((n) => n.kind !== 'wip');
    expect(commits).toHaveLength(4);
    commits.forEach((node, row) => {
      expect(node.x).toBe(laneX(cache.row(row)?.lane ?? -1));
      expect(node.y).toBe(rowCenter(row, RH, RH));
    });
    expect(commits[0]?.head).toBe(true);
  });

  it('connects every line end to a node or to another line', () => {
    const cache = cacheFor(HISTORY, 0);
    const { segments, nodes } = buildScene(input(cache));
    const points = new Set([
      ...nodes.map((n) => `${String(n.x)},${String(n.y)}`),
      ...segments.map((s) => `${String(s.x1)},${String(s.y1)}`),
    ]);
    for (const s of segments) expect(points.has(`${String(s.x2)},${String(s.y2)}`)).toBe(true);
  });

  it('draws the WIP node and its dashed line only while the WIP row is shown', () => {
    // HEAD on row 1: the WIP line passes row 0 before joining it.
    const cache = cacheFor(HISTORY, 1);
    const shown = buildScene(input(cache));
    const wipNode = shown.nodes.find((n) => n.kind === 'wip');
    expect(wipNode).toMatchObject({ y: RH / 2, x: laneX(cache.wip?.lane ?? -1) });
    const dashed = shown.segments.filter((s) => s.dashed);
    // WIP node → row 0, row 0 → row 1.
    expect(dashed).toHaveLength(2);
    expect(dashed.every((s) => s.x1 === laneX(cache.wip?.lane ?? -1))).toBe(true);

    const hidden = buildScene(input(cache, { wipHeight: 0 }));
    expect(hidden.nodes.some((n) => n.kind === 'wip')).toBe(false);
    expect(hidden.segments.some((s) => s.dashed)).toBe(false);
    // Without the WIP row, rows start at the top.
    expect(hidden.nodes[0]?.y).toBe(RH / 2);
  });

  it('includes the edges of the row above the range, for the half row at the top', () => {
    const cache = cacheFor(HISTORY, 0);
    const top = rowCenter(2, RH, RH) - RH / 2;
    const scene = buildScene(input(cache, { first: 2, last: 3, top }));
    const fromAbove = scene.segments.filter((s) => s.y1 < 0);
    expect(fromAbove.length).toBeGreaterThan(0);
    expect(scene.nodes.map((n) => n.y)).toEqual([RH / 2, RH + RH / 2]);
  });

  it('marks merges and the selected row', () => {
    const cache = cacheFor([[1, 2], [3], [3], []], null);
    const scene = buildScene(input(cache, { wipHeight: 0, selectedRow: 2 }));
    expect(scene.nodes[0]?.kind).toBe('merge');
    expect(scene.nodes[2]?.selected).toBe(true);
    expect(scene.segments.some((s) => s.dashed)).toBe(false);
  });

  it('skips rows that are not loaded', () => {
    const cache = cacheFor(HISTORY, 0);
    const scene = buildScene(input(cache, { first: 0, last: 10 }));
    expect(scene.nodes.filter((n) => n.kind !== 'wip')).toHaveLength(4);
  });

  it('only gets WIP edges from the backend for the WIP line', () => {
    const cache = cacheFor(HISTORY, 1);
    const edges = cache.edgesOf(0);
    const kinds: number[] = [];
    for (let i = edges?.from ?? 0; i < (edges?.to ?? 0); i++)
      kinds.push(edges?.edges[4 * i + 3] ?? -1);
    expect(kinds).toContain(EDGE_WIP);
  });
});

describe('drawScene', () => {
  function recorder() {
    const calls: string[] = [];
    const ctx = {
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 1,
      globalAlpha: 1,
      lineCap: 'butt',
      beginPath: vi.fn(() => calls.push('begin')),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      bezierCurveTo: vi.fn(),
      arc: vi.fn(),
      rect: vi.fn(),
      stroke: vi.fn(() => calls.push(`stroke:${ctx.strokeStyle}`)),
      fill: vi.fn(),
      setLineDash: vi.fn(),
      clearRect: vi.fn(),
    };
    return { ctx, calls };
  }

  it('batches lines by color and curves lane changes', () => {
    const { ctx, calls } = recorder();
    const palette = { lanes: ['c0', 'c1'], background: 'bg', selected: 'sel' };
    drawScene(
      ctx as unknown as GraphContext,
      {
        segments: [
          { x1: 12, y1: 0, x2: 12, y2: 28, color: 0, dashed: false },
          { x1: 12, y1: 28, x2: 12, y2: 56, color: 0, dashed: false },
          { x1: 12, y1: 0, x2: 28, y2: 28, color: 1, dashed: false },
        ],
        nodes: [],
      },
      palette,
      100,
      100,
    );
    expect(calls.filter((c) => c.startsWith('stroke'))).toEqual(['stroke:c0', 'stroke:c1']);
    expect(ctx.lineTo).toHaveBeenCalledTimes(2);
    expect(ctx.bezierCurveTo).toHaveBeenCalledOnce();
  });
});
