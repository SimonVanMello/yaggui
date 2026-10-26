import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ipc, unwrap } from '../../ipc';
import { mockBackend } from '../../ipc/mockClient';
import { GraphSource } from './graphSource';

const YAGGUI = '/Users/alex/dev/yaggui';
const LINUX = '/Users/alex/dev/linux';

const sources: GraphSource[] = [];

/** A source shown on screen (subscribed) with its first page loaded. */
async function openSource(path: string): Promise<GraphSource> {
  const info = await unwrap(ipc.commands.openRepo(path));
  const source = new GraphSource(info.id);
  sources.push(source);
  source.subscribe(() => undefined);
  source.ensure(0, 10);
  await vi.waitFor(() => {
    expect(source.cache.version).not.toBeNull();
  });
  return source;
}

beforeEach(() => {
  mockBackend.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const source of sources.splice(0)) source.dispose();
});

describe('GraphSource', () => {
  it('selects a commit located in a newer layout once that layout is loaded, never by row', async () => {
    const source = await openSource(YAGGUI);
    const target = source.cache.row(5)?.sha ?? '';
    const neighbour = source.cache.row(6)?.sha ?? '';
    expect(target).not.toBe('');
    // A commit made from a terminal: every row moves down by one in the backend's new layout,
    // but the pages on screen are still the old ones (the reload has not been triggered yet).
    mockBackend.simulateCommit(source.repoId);
    await source.goToSha(target);
    // Row 6 of the old pages is another commit: it must not be the selection.
    expect(source.selection).toMatchObject({ kind: 'commit', sha: target });
    expect(source.selection).not.toMatchObject({ sha: neighbour });
    // The reload brings the new layout: the located row applies to it.
    await vi.waitFor(() => {
      expect(source.selection).toEqual({ kind: 'commit', sha: target, row: 6 });
    });
    expect(source.cache.row(6)?.sha).toBe(target);
    expect(source.scrollRequest).toMatchObject({ row: 6, align: 'center' });
    expect([...source.picks.picked]).toEqual([[target, 6]]);
  });

  it('drops the load error once the page that failed is loaded again', async () => {
    const source = await openSource(LINUX);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(ipc.commands, 'graphPage').mockRejectedValueOnce(new Error('transient'));
    source.ensure(600, 610);
    await vi.waitFor(() => {
      expect(source.loadError).not.toBeNull();
    });
    expect(source.cache.row(600)).toBeUndefined();
    // The cache asks for a failed page again after its delay (the view calls `ensure` on
    // every scroll): the page arrives and the banner goes without the Retry button.
    vi.setSystemTime(Date.now() + 3000);
    source.ensure(600, 610);
    await vi.waitFor(() => {
      expect(source.cache.row(600)).toBeDefined();
    });
    expect(source.loadError).toBeNull();
  });

  it('⇧↓ onto a row whose page is not loaded extends the selection when it arrives', async () => {
    const source = await openSource(LINUX);
    const last = source.cache.row(499);
    expect(last).toBeDefined();
    if (!last) return;
    source.selectCommit(last.sha, 499);
    expect(source.cache.row(500)).toBeUndefined();
    source.extendSelection(1);
    await vi.waitFor(() => {
      expect(source.pickedRows.has(500)).toBe(true);
    });
    expect(source.selectedCommits().map((c) => c.row)).toEqual([499, 500]);
    expect(source.selection).toMatchObject({ kind: 'commit', row: 500 });
    expect(source.picks.anchor).toBe(499);
  });
});
