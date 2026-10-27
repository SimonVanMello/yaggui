import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { updatePreferences } from '../../app/preferences';
import { queryClient } from '../../app/queryClient';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { mockBackend, mockClient } from '../../ipc/mockClient';
import { useOpsStore } from '../repo/opsStore';
import { closeTabAndRepo, openRepoPath, useRepoSessions } from '../repo/repoSessions';
import { autoFetchedRepos, startAutoFetch, stopAutoFetch } from './autoFetch';
import { fetchRepo } from './networkOps';

vi.mock('./networkOps', () => ({ fetchRepo: vi.fn(() => Promise.resolve(true)) }));

const MINUTE = 60_000;

/** Opens the repository in a new tab (the newest tab is the active one) and returns its id. */
async function open(path: string): Promise<number> {
  await openRepoPath(path);
  const id = Object.entries(useRepoSessions.getState().sessions).find(
    ([, session]) => session?.status === 'open' && session.info.path === path,
  )?.[0];
  if (id === undefined) throw new Error(`${path} did not open`);
  return Number(id);
}

function tabOf(repoId: number): string {
  const tab = useTabsStore.getState().tabs.find((t) => t.repoId === repoId);
  if (!tab) throw new Error(`no tab for ${repoId}`);
  return tab.id;
}

function fetchedRepos(): number[] {
  return vi.mocked(fetchRepo).mock.calls.map(([repoId]) => repoId);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.mocked(fetchRepo).mockReset();
  vi.mocked(fetchRepo).mockImplementation(() => Promise.resolve(true));
  mockBackend.reset();
  queryClient.clear();
  stopAutoFetch();
  for (const tab of useTabsStore.getState().tabs) closeTabAndRepo(tab.id);
  useOpsStore.setState({ running: {}, lastFinished: {} });
  await updatePreferences({ autoFetch: true, autoFetchMinutes: 10 }, mockClient);
});

afterEach(() => {
  stopAutoFetch();
  vi.useRealTimers();
});

describe('auto-fetch of the open repositories', () => {
  it('fetches every open repository after one period, the hidden tab included', async () => {
    const alpha = await open('/repos/alpha');
    const beta = await open('/repos/beta');
    expect(useTabsStore.getState().activeTabId).toBe(tabOf(beta));
    startAutoFetch();
    expect(autoFetchedRepos().sort()).toEqual([alpha, beta].sort());

    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(fetchRepo).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(fetchedRepos().sort()).toEqual([alpha, beta].sort());
    expect(fetchRepo).toHaveBeenCalledWith(alpha, { silent: true });
    expect(fetchRepo).toHaveBeenCalledWith(beta, { silent: true });
  });

  it('starts the timer of a repository opened after the scheduler, one full period later', async () => {
    startAutoFetch();
    const alpha = await open('/repos/alpha');
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    const beta = await open('/repos/beta');
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    // Alpha's period is over, beta's has 6 minutes left: the first fetches are spread.
    expect(fetchedRepos()).toEqual([alpha]);
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    expect(fetchedRepos()).toEqual([alpha, beta]);
  });

  it('stops the timer when the last tab of the repository closes', async () => {
    startAutoFetch();
    const alpha = await open('/repos/alpha');
    const beta = await open('/repos/beta');
    closeTabAndRepo(tabOf(alpha));
    expect(autoFetchedRepos()).toEqual([beta]);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(fetchedRepos()).toEqual([beta, beta, beta]);
  });

  it('skips a tick while an operation runs in that repository', async () => {
    startAutoFetch();
    const alpha = await open('/repos/alpha');
    const beta = await open('/repos/beta');
    useOpsStore.getState().started({ opId: 7, repoId: alpha, kind: 'push', cancellable: true });
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(fetchedRepos()).toEqual([beta]);
    useOpsStore.getState().finished(alpha, {
      opId: 7,
      kind: 'push',
      outcome: 'success',
      finishedAt: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(fetchedRepos().sort()).toEqual([alpha, beta, beta].sort());
  });

  it('never fetches the same repository twice at once', async () => {
    let settle: (() => void) | undefined;
    vi.mocked(fetchRepo).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          settle = () => {
            resolve(true);
          };
        }),
    );
    startAutoFetch();
    const alpha = await open('/repos/alpha');
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(fetchedRepos()).toEqual([alpha]);
    settle?.();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(fetchedRepos()).toEqual([alpha, alpha]);
  });

  it('has no timer while auto-fetch is off, and starts them when it is turned on', async () => {
    await updatePreferences({ autoFetch: false }, mockClient);
    startAutoFetch();
    const alpha = await open('/repos/alpha');
    expect(autoFetchedRepos()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(fetchRepo).not.toHaveBeenCalled();

    await updatePreferences({ autoFetch: true }, mockClient);
    expect(autoFetchedRepos()).toEqual([alpha]);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(fetchedRepos()).toEqual([alpha]);

    await updatePreferences({ autoFetch: false }, mockClient);
    expect(autoFetchedRepos()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(fetchedRepos()).toEqual([alpha]);
  });

  it('uses a changed interval from the next period', async () => {
    startAutoFetch();
    const alpha = await open('/repos/alpha');
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(fetchedRepos()).toEqual([alpha]);
    await updatePreferences({ autoFetchMinutes: 2 }, mockClient);
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    expect(fetchedRepos()).toEqual([alpha, alpha, alpha, alpha]);
  });

  it('does not fetch a repository whose session is gone, and ignores a second start', async () => {
    startAutoFetch();
    startAutoFetch();
    const alpha = await open('/repos/alpha');
    // The session is dropped under the timer (a relocation, see `resetRepoSession`).
    useRepoSessions.setState({ sessions: {} });
    expect(autoFetchedRepos()).toEqual([]);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(fetchRepo).not.toHaveBeenCalled();
    expect(alpha).toBeGreaterThan(0);
  });
});
