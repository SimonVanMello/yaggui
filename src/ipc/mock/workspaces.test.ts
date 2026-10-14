import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScanProgress } from '../bindings';
import { mockBackend, mockClient } from '../mockClient';
import { unwrap } from '../result';

const { commands: mock } = mockClient;

beforeEach(() => {
  mockBackend.reset();
});
afterEach(() => vi.useRealTimers());

/** Same behavior as `store/workspaces.rs` and `repo/workspace.rs` (see their tests). */
describe('mock workspaces', () => {
  it('lists the fixtures by name and validates names like the store', async () => {
    const list = await unwrap(mock.listWorkspaces());
    expect(list.map((w) => [w.name, w.repoIds])).toEqual([
      ['Kernel', [2]],
      ['Personal', [1, 3, 4]],
    ]);
    const created = await unwrap(mock.createWorkspace('  Client X ', [3, 1, 999]));
    expect(created).toMatchObject({ name: 'Client X', repoIds: [3, 1] });
    await expect(mock.createWorkspace('client x', [])).resolves.toMatchObject({
      status: 'error',
      error: { code: 'invalidArgument' },
    });
    await expect(mock.createWorkspace('   ', [])).resolves.toMatchObject({ status: 'error' });
    // Renaming to its own name in another case is allowed.
    await expect(unwrap(mock.renameWorkspace(created.id, 'CLIENT X'))).resolves.toMatchObject({
      name: 'CLIENT X',
    });
  });

  it('adds, removes and forgets members', async () => {
    const added = await unwrap(mock.addToWorkspace(2, [3, 2, 1]));
    expect(added.repoIds).toEqual([2, 3, 1]);
    expect((await unwrap(mock.removeFromWorkspace(2, 3))).repoIds).toEqual([2, 1]);
    await unwrap(mock.forgetRepo(1));
    const list = await unwrap(mock.listWorkspaces());
    expect(list.find((w) => w.id === 2)?.repoIds).toEqual([2]);
    await unwrap(mock.deleteWorkspace(2));
    expect((await unwrap(mock.listWorkspaces())).map((w) => w.name)).toEqual(['Personal']);
  });

  it('reads the overview of repos that are not open', async () => {
    const yaggui = await unwrap(mock.repoOverview(1));
    expect(yaggui).toMatchObject({
      kind: 'ready',
      state: { head: { name: 'feat/graph-lanes' }, upstream: { ahead: 2 } },
    });
    await expect(unwrap(mock.repoOverview(4))).resolves.toEqual({ kind: 'missing' });
    await expect(mock.repoOverview(99)).resolves.toMatchObject({ status: 'error' });
  });

  it('fetches a known repo on a session of its own, then releases it', async () => {
    vi.useFakeTimers();
    const kinds: string[] = [];
    const off = mockClient.events.subscribe('opFinished', ({ kind, outcome }) => {
      kinds.push(`${kind}:${outcome.kind}`);
    });
    const pending = mock.fetchKnownRepo(3, true);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ status: 'ok', data: null });
    off();
    expect(kinds).toEqual(['fetch:success']);
    // The temporary session is closed again: the repo is not open.
    await expect(mock.repoState(3)).resolves.toMatchObject({ status: 'error' });
    const overview = await unwrap(mock.repoOverview(3));
    expect(overview.kind === 'ready' && overview.lastFetchedAt).toBeGreaterThan(0);
    await expect(mock.fetchKnownRepo(4, true)).resolves.toMatchObject({
      error: { code: 'repoNotFound' },
    });
  });

  it('scans with progress down to the depth, and can be cancelled', async () => {
    vi.useFakeTimers();
    const progress: ScanProgress[] = [];
    const off = mockClient.events.subscribe('scanProgress', (event) => progress.push(event));
    const pending = mock.scanFolder({ scanId: 's1', root: '/Users/alex/dev/', maxDepth: 2 });
    await vi.runAllTimersAsync();
    const result = await unwrap(pending);
    off();
    expect(result.repos.map((repo) => repo.name)).toEqual([
      'api-gateway',
      'acme-mobile',
      'acme-portal',
      'linux',
      'web-app',
      'yaggui',
    ]);
    expect(result.repos.find((repo) => repo.name === 'yaggui')?.knownId).toBe(1);
    expect(progress.at(-1)?.found).toBe(6);

    const cancelled = mock.scanFolder({ scanId: 's2', root: '/x', maxDepth: 3 });
    await unwrap(mock.cancelScan('s2'));
    await expect(cancelled).resolves.toMatchObject({ error: { code: 'cancelled' } });
    await expect(mock.scanFolder({ scanId: 's3', root: '/x', maxDepth: 0 })).resolves.toMatchObject(
      { error: { code: 'invalidArgument' } },
    );
  });

  it('imports scanned folders as never opened, into a workspace', async () => {
    const result = await unwrap(
      mock.importRepos(['/src/api', '/Users/alex/dev/yaggui', '/src/not-a-repo'], 1),
    );
    expect(result.failed.map((f) => f.error.code)).toEqual(['notARepository']);
    const known = await unwrap(mock.listRepos());
    const api = known.find((repo) => repo.path === '/src/api');
    expect(api?.lastOpenedAt).toBe(0);
    expect(result.repoIds).toEqual([api?.id, 1]);
    expect((await unwrap(mock.listWorkspaces())).find((w) => w.id === 1)?.repoIds).toEqual([
      1,
      3,
      4,
      api?.id,
    ]);
  });

  it('relocates in place, or merges into the entry already known there', async () => {
    const moved = await unwrap(mock.relocateRepo(4, '/Users/alex/dev/legacy-api'));
    expect(moved).toMatchObject({ id: 4, name: 'legacy-api', exists: true });
    const merged = await unwrap(mock.relocateRepo(4, '/Users/alex/dev/blog'));
    expect(merged.id).toBe(3);
    expect((await unwrap(mock.listRepos())).some((repo) => repo.id === 4)).toBe(false);
    expect((await unwrap(mock.listWorkspaces())).find((w) => w.id === 1)?.repoIds).toEqual([1, 3]);
    await expect(mock.relocateRepo(1, '/gone/missing')).resolves.toMatchObject({
      error: { code: 'repoNotFound' },
    });
  });
});
