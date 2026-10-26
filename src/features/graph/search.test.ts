import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ipc, unwrap, type SearchChunk } from '../../ipc';
import { mockBackend } from '../../ipc/mockClient';
import {
  isEmptySearch,
  matchIndex,
  nextMatch,
  normalizeSearch,
  runSearch,
  type SearchProgress,
} from './search';

const chunk = (patch: Partial<SearchChunk>): SearchChunk => ({
  version: 1,
  matches: [],
  nextRow: null,
  totalRows: 30,
  ...patch,
});

describe('runSearch', () => {
  it('follows nextRow to the end and accumulates the matches', async () => {
    const answers = [
      chunk({ matches: [1, 4], nextRow: 10 }),
      chunk({ matches: [], nextRow: 20 }),
      chunk({ matches: [25] }),
    ];
    const fetch = vi.fn(() => Promise.resolve(answers.shift() ?? chunk({})));
    const progress: SearchProgress[] = [];
    const result = await runSearch(fetch, (p) => progress.push(p), { cancelled: false });
    expect(fetch.mock.calls.map((c) => c as unknown[])).toEqual([[0], [10], [20]]);
    expect(result).toMatchObject({ matches: [1, 4, 25], done: true, scanned: 30 });
    expect(progress.map((p) => p.scanned)).toEqual([10, 20, 30]);
  });

  it('stops asking for chunks once cancelled', async () => {
    const token = { cancelled: false };
    const fetch = vi.fn(() => {
      token.cancelled = true;
      return Promise.resolve(chunk({ matches: [1], nextRow: 10 }));
    });
    const onProgress = vi.fn();
    expect(await runSearch(fetch, onProgress, token)).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('restarts from the top when the graph version changes', async () => {
    const answers = [
      chunk({ matches: [1], nextRow: 10 }),
      chunk({ version: 2, matches: [12], nextRow: null }),
      chunk({ version: 2, matches: [2], nextRow: 10 }),
      chunk({ version: 2, matches: [12] }),
    ];
    const calls: number[] = [];
    const fetch = vi.fn((from: number) => {
      calls.push(from);
      return Promise.resolve(answers.shift() ?? chunk({}));
    });
    const result = await runSearch(fetch, () => undefined, { cancelled: false });
    expect(calls).toEqual([0, 10, 0, 10]);
    expect(result).toMatchObject({ version: 2, matches: [2, 12] });
  });
});

describe('search helpers', () => {
  it('treats blank criteria as no criteria', () => {
    expect(isEmptySearch({ text: '  ', author: null, path: '', since: null, until: null })).toBe(
      true,
    );
    expect(
      normalizeSearch({ text: ' fix ', author: '', path: null, since: 1, until: null }),
    ).toEqual({ text: 'fix', author: null, path: null, since: 1, until: null });
  });

  it('navigates between matches, wrapping around', () => {
    const matches = [3, 8, 20];
    expect(nextMatch(matches, null, 1)).toBe(0);
    expect(nextMatch(matches, null, -1)).toBe(2);
    expect(nextMatch(matches, 3, 1)).toBe(1);
    expect(nextMatch(matches, 5, 1)).toBe(1);
    expect(nextMatch(matches, 20, 1)).toBe(0);
    expect(nextMatch(matches, 8, -1)).toBe(0);
    expect(nextMatch(matches, 10, -1)).toBe(1);
    expect(nextMatch(matches, 3, -1)).toBe(2);
    expect(nextMatch([], 3, 1)).toBeNull();
    expect(matchIndex(matches, 8)).toBe(1);
    expect(matchIndex(matches, 9)).toBe(-1);
  });
});

describe('search on the mock backend', () => {
  beforeEach(() => {
    mockBackend.reset();
  });

  // Scans 100k mock rows chunk by chunk: well under a second alone, but the default 5 s is
  // too tight on a loaded CI machine. The work is the point of the test, not its speed.
  const SCAN_TIMEOUT_MS = 30_000;

  it(
    'finds the commits of an author across the 100k rows of linux',
    async () => {
      await unwrap(ipc.commands.openRepo('/Users/alex/dev/linux'));
      const query = normalizeSearch({
        text: null,
        author: 'kenji',
        path: null,
        since: null,
        until: null,
      });
      const result = await runSearch(
        (from) => unwrap(ipc.commands.searchCommits(2, query, from)),
        () => undefined,
        { cancelled: false },
      );
      expect(result?.done).toBe(true);
      expect(result?.matches.length).toBeGreaterThan(1000);
      const page = await unwrap(ipc.commands.graphPage(2, result?.matches[0] ?? 0, 1));
      expect(page.authorNames[0]).toBe('Kenji Watanabe');
    },
    SCAN_TIMEOUT_MS,
  );
});
