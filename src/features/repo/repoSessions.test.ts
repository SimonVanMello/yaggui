import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RepoInfo } from '../../ipc';

const calls = vi.hoisted(() => ({ open: [] as number[], close: [] as number[] }));
const pending = vi.hoisted(() => ({ gate: null as Promise<void> | null }));

const info = (id: number, path: string): RepoInfo => ({
  id,
  path,
  name: path.split('/').pop() ?? path,
  state: {
    head: { kind: 'branch', name: 'main', oid: 'a'.repeat(40) },
    upstream: null,
    dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    operation: null,
    indexLock: null,
  },
  watchError: null,
});

/** `/repos/yaggui/src` resolves to the same repository as `/repos/yaggui`. */
function idFor(path: string): number {
  return path.startsWith('/repos/yaggui') ? 1 : 2;
}

vi.mock('../../ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ipc')>();
  const ok = <T>(data: T) => Promise.resolve({ status: 'ok' as const, data });
  return {
    ...actual,
    ipc: {
      ...actual.ipc,
      commands: {
        ...actual.ipc.commands,
        openRepo: async (path: string) => {
          if (pending.gate) await pending.gate;
          const id = idFor(path);
          calls.open.push(id);
          return { status: 'ok' as const, data: info(id, path) };
        },
        closeRepo: (repoId: number) => {
          calls.close.push(repoId);
          return ok(null);
        },
        listRepos: () =>
          ok([
            {
              id: 1,
              path: '/repos/yaggui',
              name: 'yaggui',
              favorite: false,
              lastOpenedAt: 0,
              exists: true,
            },
          ]),
      },
    },
  };
});

const {
  closeTabAndRepo,
  heldSessionCount,
  resetRepoSession,
  restoreRepoSession,
  tryOpenRepo,
  useRepoSessions,
} = await import('./repoSessions');
const { useTabsStore } = await import('../../app/tabs/tabsStore');
const { queryClient } = await import('../../app/queryClient');

/** Backend references still open, per repository. */
function balance(): Record<number, number> {
  const counts: Record<number, number> = {};
  calls.open.forEach((id) => (counts[id] = (counts[id] ?? 0) + 1));
  calls.close.forEach((id) => (counts[id] = (counts[id] ?? 0) - 1));
  return Object.fromEntries(Object.entries(counts).filter(([, count]) => count !== 0));
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  // Close every tab from a previous test, which releases its sessions.
  for (const tab of useTabsStore.getState().tabs) closeTabAndRepo(tab.id);
  calls.open.length = 0;
  calls.close.length = 0;
  pending.gate = null;
  useRepoSessions.setState({ sessions: {} });
  queryClient.clear();
});

describe('repository sessions keep openRepo / closeRepo balanced', () => {
  it('holds one reference per tab and releases it when the tab closes', async () => {
    await tryOpenRepo('/repos/yaggui', useTabsStore.getState().activeTabId);
    expect(balance()).toEqual({ 1: 1 });
    closeTabAndRepo(useTabsStore.getState().activeTabId);
    expect(balance()).toEqual({});
    expect(heldSessionCount()).toBe(0);
  });

  it('gives back the extra reference when an open repository is opened again', async () => {
    await tryOpenRepo('/repos/yaggui', useTabsStore.getState().activeTabId);
    await tryOpenRepo('/repos/yaggui/src');
    expect(useTabsStore.getState().tabs.filter((tab) => tab.repoId === 1)).toHaveLength(1);
    expect(calls.open).toEqual([1, 1]);
    expect(balance()).toEqual({ 1: 1 });
    closeTabAndRepo(useTabsStore.getState().activeTabId);
    expect(balance()).toEqual({});
  });

  it('balances an open that completes after its tab was closed', async () => {
    let release: () => void = () => undefined;
    pending.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = useTabsStore.getState();
    store.setRepo(store.activeTabId, 1);
    const restoring = restoreRepoSession(1);
    await flush();
    closeTabAndRepo(useTabsStore.getState().tabs.find((tab) => tab.repoId === 1)?.id ?? '');
    release();
    await restoring;
    expect(calls.open).toEqual([1]);
    expect(balance()).toEqual({});
    expect(useRepoSessions.getState().sessions[1]).toBeUndefined();
  });

  it('balances a restore racing with an explicit open of the same repository', async () => {
    let release: () => void = () => undefined;
    pending.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = useTabsStore.getState();
    store.setRepo(store.activeTabId, 1);
    const restoring = restoreRepoSession(1);
    const opening = tryOpenRepo('/repos/yaggui');
    await flush();
    release();
    await Promise.all([restoring, opening]);
    expect(calls.open).toEqual([1, 1]);
    expect(balance()).toEqual({ 1: 1 });
  });
});

describe('closing the last tab of a repository forgets what was cached about it', () => {
  it('removes every per-repository query, not only the state and the refs', async () => {
    await tryOpenRepo('/repos/yaggui', useTabsStore.getState().activeTabId);
    const mine = [
      ['repo-state', 1],
      ['repo-refs', 1],
      ['diff', 1, 'worktree', 'files', 'staged'],
      ['conflicts', 1],
      ['remotes', 1],
      ['git-config', 'repo', 1],
    ];
    const others = [
      ['repo-state', 2],
      ['diff', 2, 'worktree', 'files', 'staged'],
      ['git-config', 'global', null],
      ['known-repos'],
    ];
    for (const key of [...mine, ...others]) queryClient.setQueryData(key, 'cached');
    closeTabAndRepo(useTabsStore.getState().activeTabId);
    for (const key of mine) expect(queryClient.getQueryData(key)).toBeUndefined();
    for (const key of others) expect(queryClient.getQueryData(key)).toBe('cached');
  });

  it('reads the repository again when it is reopened', async () => {
    await tryOpenRepo('/repos/yaggui', useTabsStore.getState().activeTabId);
    queryClient.setQueryData(['diff', 1, 'worktree', 'files', 'staged'], 'previous session');
    closeTabAndRepo(useTabsStore.getState().activeTabId);
    await tryOpenRepo('/repos/yaggui', useTabsStore.getState().activeTabId);
    expect(queryClient.getQueryData(['diff', 1, 'worktree', 'files', 'staged'])).toBeUndefined();
  });
});

describe('resetRepoSession', () => {
  it('drops a session the backend closed, without closing it again, so the tab reopens it', async () => {
    await tryOpenRepo('/repos/yaggui', useTabsStore.getState().activeTabId);
    queryClient.setQueryData(['diff', 1, 'worktree', 'files', 'staged'], 'old folder');
    resetRepoSession(1);
    expect(useRepoSessions.getState().sessions[1]).toBeUndefined();
    expect(heldSessionCount()).toBe(0);
    expect(calls.close).toEqual([]);
    expect(queryClient.getQueryData(['diff', 1, 'worktree', 'files', 'staged'])).toBeUndefined();
    await restoreRepoSession(1);
    expect(useRepoSessions.getState().sessions[1]?.status).toBe('open');
    // The backend closed the first session itself: only the reopen is held.
    expect(calls.open).toEqual([1, 1]);
    expect(calls.close).toEqual([]);
    expect(heldSessionCount()).toBe(1);
  });
});
