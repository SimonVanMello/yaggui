import { describe, expect, it, vi } from 'vitest';

import {
  SIGNATURE_GPG,
  SIGNATURE_NONE,
  SIGNATURE_SSH,
  SIGNATURE_UNKNOWN,
  SIGNATURE_X509,
  type GraphPage,
} from '../../ipc';
import { GraphPageCache, toRows } from './pageCache';

const PAGE = 10;

function fakePage(start: number, limit: number, total: number, version = 1): GraphPage {
  const end = Math.min(total, start + limit);
  const n = Math.max(0, end - start);
  const rows = Array.from({ length: n }, (_, k) => start + k);
  return {
    version,
    start,
    totalRows: total,
    totalExact: true,
    laneCount: 2,
    wip: null,
    shas: rows.map((r) => `sha${String(r)}`),
    parents: rows.map((r) => [`sha${String(r + 1)}`]),
    summaries: rows.map((r) => `commit ${String(r)}`),
    authorNames: rows.map(() => 'A'),
    authorEmails: rows.map(() => 'a@x'),
    authorTimes: rows.map(() => 0),
    commitTimes: rows.map(() => 0),
    lanes: rows.map(() => 0),
    colors: rows.map(() => 0),
    signatures: rows.map(() => 0),
    // One edge per row.
    edgeOffsets: Array.from({ length: n + 1 }, (_, k) => k),
    edges: rows.flatMap(() => [0, 0, 0, 0]),
    refs:
      start === 0
        ? [
            {
              row: 0,
              label: {
                kind: 'tag',
                name: 'v1',
                fullName: 'refs/tags/v1',
                isHead: false,
                upstream: null,
              },
            },
          ]
        : [],
  };
}

function setup(total: number, options: { maxPages?: number; version?: () => number } = {}) {
  const calls: number[] = [];
  const resolvers: (() => void)[] = [];
  const fetcher = vi.fn((start: number, limit: number) => {
    calls.push(start);
    return new Promise<GraphPage>((resolve) => {
      resolvers.push(() => {
        resolve(fakePage(start, limit, total, options.version?.() ?? 1));
      });
    });
  });
  const onChange = vi.fn();
  const onVersionMismatch = vi.fn();
  const cache = new GraphPageCache(fetcher, {
    pageSize: PAGE,
    prefetchRows: 0,
    maxPages: options.maxPages ?? 3,
    onChange,
    onVersionMismatch,
  });
  const flush = async () => {
    while (resolvers.length > 0) resolvers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { cache, calls, fetcher, flush, onChange, onVersionMismatch };
}

describe('GraphPageCache', () => {
  it('maps rows, refs and edges of a page', () => {
    const { cache } = setup(25);
    cache.insert(fakePage(0, PAGE, 25));
    expect(cache.totalRows).toBe(25);
    expect(cache.row(3)?.summary).toBe('commit 3');
    expect(cache.row(0)?.refs.map((r) => r.name)).toEqual(['v1']);
    expect(cache.row(3)?.refs).toEqual([]);
    expect(cache.edgesOf(3)).toMatchObject({ from: 3, to: 4 });
    expect(cache.row(10)).toBeUndefined();
  });

  it('requests each missing page once, with its prefetch margin', async () => {
    const { cache, calls, flush } = setup(100);
    cache.insert(fakePage(0, PAGE, 100));
    cache.ensure(12, 25);
    cache.ensure(12, 25);
    expect(calls).toEqual([10, 20]);
    await flush();
    expect(cache.row(25)?.sha).toBe('sha25');
    expect(cache.pending).toBe(0);
  });

  it('does not request pages past the end', () => {
    const { cache, calls } = setup(25);
    cache.insert(fakePage(0, PAGE, 25));
    cache.ensure(15, 60);
    expect(calls).toEqual([10, 20]);
  });

  it('evicts the least recently used pages but keeps the requested range', async () => {
    const { cache, flush } = setup(100, { maxPages: 2 });
    cache.insert(fakePage(0, PAGE, 100));
    cache.ensure(10, 19);
    await flush();
    cache.ensure(20, 39);
    await flush();
    // Pages 2 and 3 were just requested: 0 and 1 go first.
    expect(cache.loadedPages).toBe(2);
    expect(cache.has(25)).toBe(true);
    expect(cache.has(35)).toBe(true);
    expect(cache.has(5)).toBe(false);
  });

  it('drops pages of another version and reports it', async () => {
    let version = 1;
    const { cache, flush, onVersionMismatch } = setup(100, { version: () => version });
    cache.insert(fakePage(0, PAGE, 100));
    version = 2;
    cache.ensure(10, 10);
    await flush();
    expect(cache.has(10)).toBe(false);
    expect(onVersionMismatch).toHaveBeenCalledOnce();
  });

  it('ignores answers to requests made before a reset', async () => {
    const { cache, flush } = setup(100);
    cache.insert(fakePage(0, PAGE, 100));
    cache.ensure(10, 10);
    cache.reset();
    await flush();
    expect(cache.version).toBeNull();
    expect(cache.loadedPages).toBe(0);
  });

  it('waits before requesting a failed page again', async () => {
    let now = 0;
    const fetcher = vi.fn(() => Promise.reject(new Error('boom')));
    const onError = vi.fn();
    const cache = new GraphPageCache(fetcher, {
      pageSize: PAGE,
      prefetchRows: 0,
      retryDelayMs: 1000,
      onError,
      now: () => now,
    });
    cache.ensure(0, 0);
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledOnce();
    cache.ensure(0, 0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 1500;
    cache.ensure(0, 0);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('grows the total while the history walk runs, never shrinks it', () => {
    const cache = new GraphPageCache(vi.fn(), { pageSize: PAGE });
    const partial = (start: number, known: number): GraphPage => ({
      ...fakePage(start, PAGE, 1000),
      totalRows: known,
      totalExact: false,
    });
    cache.insert(partial(0, 40));
    expect(cache.totalRows).toBe(40);
    expect(cache.totalExact).toBe(false);
    // A later page saw more of the history, an older answer arriving late less.
    cache.insert(partial(30, 90));
    cache.insert(partial(10, 50));
    expect(cache.totalRows).toBe(90);
    // `graphProgress` of this version only.
    expect(cache.progress(2, 500, true)).toBe(false);
    expect(cache.progress(1, 300, false)).toBe(true);
    expect(cache.totalRows).toBe(300);
    expect(cache.progress(1, 1000, true)).toBe(true);
    expect(cache.totalRows).toBe(1000);
    expect(cache.totalExact).toBe(true);
    cache.insert(partial(40, 120));
    expect(cache.totalExact).toBe(true);
    expect(cache.totalRows).toBe(1000);
    // Another version starts over.
    cache.reset();
    cache.insert({ ...partial(0, 20), version: 2 });
    expect(cache.totalRows).toBe(20);
    expect(cache.totalExact).toBe(false);
  });

  it("keeps HEAD's row once a page had it", () => {
    const cache = new GraphPageCache(vi.fn(), { pageSize: PAGE });
    const wip = { lane: 0, color: 3, headRow: 42 };
    cache.insert(fakePage(0, PAGE, 100));
    expect(cache.wip).toBeNull();
    cache.insert({ ...fakePage(40, PAGE, 100), wip });
    cache.insert(fakePage(10, PAGE, 100));
    expect(cache.wip).toEqual(wip);
    cache.reset();
    cache.insert({ ...fakePage(0, PAGE, 100), version: 2 });
    expect(cache.wip).toBeNull();
  });
});

describe('toRows', () => {
  it('decodes the signature codes', () => {
    const codes = [
      SIGNATURE_NONE,
      SIGNATURE_GPG,
      SIGNATURE_SSH,
      SIGNATURE_X509,
      SIGNATURE_UNKNOWN,
      9,
    ];
    const page = { ...fakePage(0, codes.length, codes.length), signatures: codes };
    expect(toRows(page).map((r) => r.signature)).toEqual([
      null,
      'gpg',
      'ssh',
      'x509',
      'unknown',
      null,
    ]);
  });
});
