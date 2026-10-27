import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '../../app/queryClient';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { ipc, type YagguiError } from '../../ipc';
import { mockBackend } from '../../ipc/mockClient';
import { closeTabAndRepo, openRepoPath, useRepoSessions } from '../repo/repoSessions';
import { useToastStore } from '../../ui/toastStore';
import { fetchWorkspace, forgetRepo, openWorkspace, relocateRepo } from './workspaceOps';
import { useWorkspaceUi } from './workspaceStore';

const perso = { id: 1, name: 'Personal', repoIds: [1, 3, 4] };

function error(code: YagguiError['code']): YagguiError {
  return { code, message: { en: code, fr: code }, action: null, detail: null, payload: null };
}

beforeEach(() => {
  mockBackend.reset();
  queryClient.clear();
  // Closing every tab leaves a single welcome tab.
  for (const tab of useTabsStore.getState().tabs) closeTabAndRepo(tab.id);
  useWorkspaceUi.setState({ fetches: {}, manager: null, missing: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  useToastStore.setState({ toasts: [] });
});

describe('openWorkspace', () => {
  it('opens the existing repos in workspace order, first in the welcome tab', async () => {
    const welcome = useTabsStore.getState().tabs[0]?.id;
    await openWorkspace(perso, welcome);
    const { tabs, activeTabId } = useTabsStore.getState();
    expect(tabs.map((tab) => tab.repoId)).toEqual([1, 3]);
    expect(tabs[0]?.id).toBe(welcome);
    expect(activeTabId).toBe(welcome);
    // legacy-api is missing: skipped, with a way to review it.
    const [toast] = useToastStore.getState().toasts;
    expect(toast).toMatchObject({ variant: 'warning', description: 'legacy-api' });
    toast?.action?.onClick();
    expect(useWorkspaceUi.getState().manager).toEqual({ workspaceId: 1 });
  });
});

describe('openWorkspace with repos already open', () => {
  it('uses the welcome tab for the first repo that has no tab yet', async () => {
    await openWorkspace(
      { id: 1, name: 'Personal', repoIds: [1] },
      useTabsStore.getState().tabs[0]?.id,
    );
    const welcome = useTabsStore.getState().newTab();
    await openWorkspace(perso, welcome);
    expect(useTabsStore.getState().tabs.map((tab) => tab.repoId)).toEqual([1, 3]);
    expect(useTabsStore.getState().tabs[1]?.id).toBe(welcome);
  });

  it('closes the welcome tab when every repo already has a tab', async () => {
    await openWorkspace(
      { id: 1, name: 'Personal', repoIds: [1, 3] },
      useTabsStore.getState().tabs[0]?.id,
    );
    const welcome = useTabsStore.getState().newTab();
    await openWorkspace(perso, welcome);
    const { tabs } = useTabsStore.getState();
    expect(tabs.map((tab) => tab.repoId)).toEqual([1, 3]);
    expect(tabs.some((tab) => tab.id === welcome)).toBe(false);
  });
});

describe('forgetRepo', () => {
  it('closes the tab of the repo it forgets', async () => {
    await openWorkspace(
      { id: 1, name: 'Personal', repoIds: [1, 3] },
      useTabsStore.getState().tabs[0]?.id,
    );
    await forgetRepo(3);
    expect(useTabsStore.getState().tabs.map((tab) => tab.repoId)).toEqual([1]);
  });
});

describe('fetchWorkspace', () => {
  it('fetches every existing repo and keeps each result', async () => {
    const fetch = vi
      .spyOn(ipc.commands, 'fetchKnownRepo')
      .mockImplementation((repoId) =>
        Promise.resolve(
          repoId === 3
            ? { status: 'error', error: error('authFailed') }
            : { status: 'ok', data: null },
        ),
      );
    await fetchWorkspace(perso);
    expect(fetch.mock.calls.map(([id]) => id)).toEqual([1, 3]);
    expect(useWorkspaceUi.getState().fetches).toEqual({
      1: { status: 'done' },
      3: { status: 'failed', error: error('authFailed') },
    });
    expect(useToastStore.getState().toasts[0]).toMatchObject({ variant: 'warning' });
  });
});

describe('relocateRepo', () => {
  it('reopens the repository of an open tab from its new folder', async () => {
    const known = await ipc.commands.listRepos();
    const path = known.status === 'ok' ? known.data[0]?.path : undefined;
    if (!path) throw new Error('a known repo is expected');
    await openRepoPath(path, useTabsStore.getState().tabs[0]?.id);
    const tab = useTabsStore.getState().tabs.find((t) => t.repoId !== null);
    const repoId = tab?.repoId ?? -1;
    expect(useRepoSessions.getState().sessions[repoId]?.status).toBe('open');
    queryClient.setQueryData(['diff', repoId, 'worktree', 'files', 'staged'], 'old folder');

    await expect(relocateRepo(repoId, '/Users/alex/dev/moved')).resolves.toBe(true);
    // The backend closed the old session; the tab opened a new one on the new folder.
    await vi.waitFor(() => {
      expect(useRepoSessions.getState().sessions[repoId]?.status).toBe('open');
    });
    const settings = await ipc.commands.commitSettings(repoId);
    expect(settings.status).toBe('ok');
    expect(
      queryClient.getQueryData(['diff', repoId, 'worktree', 'files', 'staged']),
    ).toBeUndefined();
    const session = useRepoSessions.getState().sessions[repoId];
    expect(session?.status === 'open' && session.info.path).toBe('/Users/alex/dev/moved');
  });

  it('moves the tabs of a repo merged into another entry', async () => {
    const tabs = useTabsStore.getState();
    const tabId = tabs.tabs[0]?.id ?? '';
    tabs.setRepo(tabId, 4);
    await expect(relocateRepo(4, '/Users/alex/dev/blog')).resolves.toBe(true);
    expect(useTabsStore.getState().tabs[0]?.repoId).toBe(3);
  });
});
