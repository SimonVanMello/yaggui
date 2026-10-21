import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EDGE_MERGE,
  EDGE_WIP,
  GRAPH_PAGE_SIZE,
  type GraphPage,
  type GraphProgress,
} from './bindings';
import { mockBackend, mockClient } from './mockClient';
import { countExclusive, createMockHistory, type MockHistory } from './mockGraph';
import { computeLayout } from './mockLayout';
import { unwrap } from './result';

const { commands: mock } = mockClient;

beforeEach(() => {
  mockBackend.reset();
});

/** Edges of the page's row `k`, as `[from, to, color, kind]` tuples. */
function rowEdges(page: GraphPage, k: number): number[][] {
  const out: number[][] = [];
  const from = page.edgeOffsets[k] ?? 0;
  const to = page.edgeOffsets[k + 1] ?? from;
  for (let i = from; i < to; i++) out.push(page.edges.slice(4 * i, 4 * i + 4));
  return out;
}

/** Structural checks every page must pass, whatever the history. */
function checkPage(page: GraphPage) {
  const n = page.shas.length;
  for (const column of [
    page.parents,
    page.summaries,
    page.authorNames,
    page.authorEmails,
    page.authorTimes,
    page.commitTimes,
    page.lanes,
    page.colors,
    page.signatures,
  ]) {
    expect(column).toHaveLength(n);
  }
  expect(page.edgeOffsets).toHaveLength(n + 1);
  expect(page.edges.length % 4).toBe(0);
  expect(page.edgeOffsets[n]).toBe(page.edges.length / 4);
  const rowIndex = new Map(page.shas.map((sha, k) => [sha, k]));
  for (let k = 0; k < n; k++) {
    // A parent on the next row is always linked to it.
    for (const parent of page.parents[k] ?? []) {
      expect(rowIndex.get(parent) ?? Infinity).toBeGreaterThan(k);
      if (rowIndex.get(parent) === k + 1) {
        expect(rowEdges(page, k)).toContainEqual(
          expect.arrayContaining([page.lanes[k], page.lanes[k + 1]]),
        );
      }
    }
    for (const [from, to] of rowEdges(page, k)) {
      expect(from).toBeLessThan(page.laneCount);
      expect(to).toBeLessThan(page.laneCount);
    }
  }
}

describe('mock graph', () => {
  it('pages the history of a repository with merges, tags and stashes', async () => {
    await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    const page = await unwrap(mock.graphPage(1, 0, GRAPH_PAGE_SIZE));
    expect(page.totalRows).toBeGreaterThan(600);
    expect(page.shas).toHaveLength(GRAPH_PAGE_SIZE);
    checkPage(page);
    expect(page.parents.some((p) => p.length > 2)).toBe(true);
    expect(page.edges.some((_, i) => i % 4 === 3 && page.edges[i] === EDGE_MERGE)).toBe(true);
    // HEAD is on the first lane, so the WIP line ends on it.
    expect(page.wip).toMatchObject({ lane: 0 });
    const headRow = page.wip?.headRow ?? -1;
    expect(page.shas[headRow]).toBe('3f9c2a17d0b4e85c6a91f2d7e0c4b3a8f5d61e92');
    expect(page.refs.map((r) => r.label.kind)).toEqual(
      expect.arrayContaining(['localBranch', 'remoteBranch', 'stash']),
    );
    const rest = await unwrap(mock.graphPage(1, GRAPH_PAGE_SIZE, GRAPH_PAGE_SIZE));
    expect(rest.start).toBe(GRAPH_PAGE_SIZE);
    expect(rest.shas).toHaveLength(page.totalRows - GRAPH_PAGE_SIZE);
    checkPage(rest);
  });

  it('serves a 100k-row history with a detached HEAD', async () => {
    await unwrap(mock.openRepo('/Users/alex/dev/linux'));
    const first = await unwrap(mock.graphPage(2, 0, 100));
    expect(first.totalRows).toBeGreaterThanOrEqual(100_000);
    const last = await unwrap(mock.graphPage(2, first.totalRows - 50, 500));
    expect(last.shas).toHaveLength(50);
    checkPage(last);
    const refs = await unwrap(mock.listRefs(2));
    expect(refs.head.kind).toBe('detached');
    const location = await unwrap(mock.graphIndexOf(2, 'HEAD'));
    expect(location.sha).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
    const around = await unwrap(mock.graphPage(2, location.row ?? 0, 1));
    expect(around.refs).toContainEqual(
      expect.objectContaining({ label: expect.objectContaining({ kind: 'head' }) as unknown }),
    );
  });

  it('lists refs consistent with the repository state', async () => {
    await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    const refs = await unwrap(mock.listRefs(3));
    const main = refs.local.find((b) => b.name === 'main');
    expect(main).toMatchObject({ isHead: true, upstream: { name: 'origin/main', behind: 4 } });
    expect(refs.graphVersion).not.toBeNull();
    const page = await unwrap(mock.graphPage(3, 0, 10));
    expect(page.shas[main?.row ?? -1]).toBe(main?.sha);
  });

  it('returns an empty graph for an unborn repository', async () => {
    await unwrap(mock.openRepo('/Users/alex/dev/unborn-project'));
    const repos = await unwrap(mock.listRepos());
    const id = repos.find((r) => r.name === 'unborn-project')?.id ?? -1;
    const page = await unwrap(mock.graphPage(id, 0, 500));
    expect(page).toMatchObject({ totalRows: 0, shas: [], edgeOffsets: [0], wip: null });
    await expect(mock.graphIndexOf(id, 'HEAD')).resolves.toMatchObject({
      status: 'error',
      error: { code: 'revisionNotFound' },
    });
  });

  it('searches by text, author, path and date, chunk by chunk', async () => {
    await unwrap(mock.openRepo('/Users/alex/dev/linux'));
    const query = { text: 'merge', author: null, path: null, since: null, until: null };
    const first = await unwrap(mock.searchCommits(2, query, 0));
    expect(first.nextRow).not.toBeNull();
    expect(first.matches.length).toBeGreaterThan(0);
    const page = await unwrap(mock.graphPage(2, first.matches[0] ?? 0, 1));
    expect(page.summaries[0]?.toLowerCase()).toContain('merge');
    const byPath = await unwrap(
      mock.searchCommits(2, { ...query, text: null, path: 'src/theme' }, 0),
    );
    expect(byPath.matches.length).toBeGreaterThan(0);
    const upper = await unwrap(
      mock.searchCommits(2, { ...query, text: null, path: 'SRC/Theme' }, 0),
    );
    expect(upper.matches).toEqual(byPath.matches);
  });

  it('describes a commit', async () => {
    await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    const detail = await unwrap(mock.commitDetail(1, '3f9c2a17d0b4e85c6a91f2d7e0c4b3a8f5d61e92'));
    expect(detail.refs.some((r) => r.isHead && r.name === 'feat/graph-lanes')).toBe(true);
    expect(detail.message.startsWith(detail.summary)).toBe(true);
  });

  it('changes the graph version when a commit is made', async () => {
    vi.useFakeTimers();
    await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    const before = await unwrap(mock.graphPage(1, 0, 10));
    const seen: number[] = [];
    const unsubscribe = mockClient.events.subscribe('refsChanged', ({ repoId }) => {
      seen.push(repoId);
    });
    const sha = mockBackend.simulateCommit(1);
    vi.runAllTimers();
    const after = await unwrap(mock.graphPage(1, 0, 10));
    expect(seen).toEqual([1]);
    expect(after.version).not.toBe(before.version);
    expect(after.totalRows).toBe(before.totalRows + 1);
    expect(after.shas[after.wip?.headRow ?? -1]).toBe(sha);
    unsubscribe();
    vi.useRealTimers();
  });

  it('holds the history walk like a backend without commit-graph', async () => {
    await unwrap(mock.openRepo('/Users/alex/dev/linux'));
    mockBackend.holdHistoryWalk(1200);
    const first = await unwrap(mock.graphPage(2, 0, 500));
    expect(first.totalExact).toBe(false);
    expect(first.totalRows).toBe(1200);
    const seen: GraphProgress[] = [];
    const unsubscribe = mockClient.events.subscribe('graphProgress', (progress) => {
      seen.push(progress);
    });
    mockBackend.releaseHistoryWalk();
    const page = await unwrap(mock.graphPage(2, 0, 500));
    expect(page.totalExact).toBe(true);
    expect(page.shas).toEqual(first.shas);
    expect(seen).toEqual([
      { repoId: 2, version: page.version, totalRows: page.totalRows, exact: true, stale: false },
    ]);
    unsubscribe();
  });
});

describe('first-parent mode (F-032)', () => {
  async function allRows(repoId: number): Promise<GraphPage> {
    const first = await unwrap(mock.graphPage(repoId, 0, GRAPH_PAGE_SIZE));
    const all = structuredClone(first);
    while (all.shas.length < all.totalRows) {
      const next = await unwrap(mock.graphPage(repoId, all.shas.length, GRAPH_PAGE_SIZE));
      expect(next.version).toBe(all.version);
      const base = all.edges.length / 4;
      all.edgeOffsets.pop();
      all.edgeOffsets.push(...next.edgeOffsets.map((o) => o + base));
      for (const key of ['shas', 'parents', 'lanes', 'edges', 'refs'] as const) {
        (all[key] as unknown[]).push(...next[key]);
      }
    }
    return all;
  }

  const filter = {
    hidden: [],
    solo: null,
    hideRemotes: false,
    hideStashes: false,
    firstParent: true,
  };

  it('walks every tip along first parents only, without merge lines', async () => {
    await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    const full = await allRows(1);
    expect(await unwrap(mock.setGraphFilter(1, filter))).toEqual(filter);
    const fp = await allRows(1);
    expect(fp.version).not.toBe(full.version);
    expect(fp.shas.length).toBeLessThan(full.shas.length);
    // Pages of 500 join up, and the layout only links rows to their first parent.
    checkPage({ ...fp, parents: fp.parents.map((p) => p.slice(0, 1)) });
    expect(fp.edges.some((_, i) => i % 4 === 3 && fp.edges[i] === EDGE_MERGE)).toBe(false);
    // Merges stay rows, with every parent listed.
    expect(fp.parents.some((p) => p.length > 1)).toBe(true);
    // Every row is a tip or the first parent of another row.
    const rows = new Set(fp.shas);
    const firstParents = new Set(fp.parents.map((p) => p[0]));
    const tips = new Set(fp.refs.map((r) => fp.shas[r.row]));
    for (const sha of fp.shas) expect(tips.has(sha) || firstParents.has(sha)).toBe(true);
    for (const p of firstParents) if (p !== undefined) expect(rows.has(p)).toBe(true);
    // Without the merge lines, branches need fewer lanes.
    expect(Math.max(...fp.lanes)).toBeLessThan(Math.max(...full.lanes));
    // HEAD keeps its WIP line.
    expect(fp.wip?.headRow).toBe(fp.shas.indexOf('3f9c2a17d0b4e85c6a91f2d7e0c4b3a8f5d61e92'));

    // A commit only reachable through a merge's other parents is not a row: jumps say so.
    const outside = full.shas.find((sha) => !rows.has(sha)) ?? '';
    expect(outside).not.toBe('');
    expect(await unwrap(mock.graphIndexOf(1, outside))).toMatchObject({ row: null });
    // The search only scans the first-parent rows.
    const chunk = await unwrap(
      mock.searchCommits(
        1,
        { text: outside.slice(0, 10), author: null, path: null, since: null, until: null },
        0,
      ),
    );
    expect(chunk.matches).toEqual([]);

    // Leaving the mode gives the full graph back.
    await unwrap(mock.setGraphFilter(1, { ...filter, firstParent: false }));
    expect((await allRows(1)).shas).toEqual(full.shas);
  });
});

describe('countExclusive', () => {
  function reachable(history: MockHistory, tip: number): Set<number> {
    const seen = new Set<number>();
    const stack = [tip];
    for (let c = stack.pop(); c !== undefined; c = stack.pop()) {
      if (seen.has(c)) continue;
      seen.add(c);
      stack.push(...(history.commits[c]?.parents ?? []));
    }
    return seen;
  }

  it('matches a full walk of both histories (rev-list --count hidden..tip)', () => {
    const history = createMockHistory(
      1,
      '/Users/alex/dev/yaggui',
      { kind: 'branch', name: 'feat/graph-lanes', oid: 'a'.repeat(40) },
      { name: 'origin/feat/graph-lanes', ahead: 2, behind: 3, gone: false },
      1_791_795_600,
    );
    const refs = [...history.local, ...history.remote, ...history.tags].map((r) => r.commit);
    expect(refs.length).toBeGreaterThan(10);
    for (const tip of refs) {
      for (const hidden of refs) {
        const excluded = reachable(history, hidden);
        const expected = [...reachable(history, tip)].filter((c) => !excluded.has(c)).length;
        expect(countExclusive(history, tip, hidden)).toBe(expected);
      }
    }
  });
});

describe('lane layout', () => {
  it('lays out a fork and its merge', () => {
    // 0: merge(1, 2) · 1: main · 2: feature · 3: base
    const layout = computeLayout([[1, 2], [3], [3], []], ['m', 'm', 'f', 'b'], 0, 'm');
    expect(Array.from(layout.lanes)).toEqual([0, 0, 1, 0]);
    expect(layout.wip).toMatchObject({ lane: 0, headRow: 0 });
    const edges = (r: number) =>
      layout.edges.slice(4 * (layout.edgeOffsets[r] ?? 0), 4 * (layout.edgeOffsets[r + 1] ?? 0));
    // Row 0: first parent straight down, second parent to a new lane.
    expect(edges(0)).toEqual([0, 0, layout.colors[0], 0, 0, 1, layout.colors[2], EDGE_MERGE]);
    // Row 2: the feature lane joins the base commit on lane 0.
    expect(edges(2).slice(4)).toEqual([1, 0, layout.colors[2], 0]);
  });

  it('keeps the WIP lane down to a HEAD that is not the newest commit', () => {
    // 0: other tip · 1: HEAD · 2: base
    const layout = computeLayout([[2], [2], []], ['o', 'h', 'b'], 1, 'h');
    expect(Array.from(layout.lanes)).toEqual([1, 0, 0]);
    expect(layout.edges.slice(0, 4)).toEqual([0, 0, layout.wip?.color, EDGE_WIP]);
  });
});
