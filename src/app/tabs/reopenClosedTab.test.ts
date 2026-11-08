import { beforeEach, describe, expect, it } from 'vitest';

import { queryClient } from '../queryClient';
import { mockBackend } from '../../ipc/mockClient';
import { renameKnownRepo } from '../../features/repo/knownRepoActions';
import {
  closeTabAndRepo,
  closeTabsAndRepos,
  openRepoPath,
  repoDisplayName,
  useRepoSessions,
} from '../../features/repo/repoSessions';
import { useWorkspaceUi } from '../../features/workspaces/workspaceStore';
import { canReopenClosedTab, reopenClosedTab } from './reopenClosedTab';
import { selectActiveTab, useTabsStore } from './tabsStore';

const YAGGUI = '/Users/alex/dev/yaggui';
const LINUX = '/Users/alex/dev/linux';
const BLOG = '/Users/alex/dev/blog';

const repoOrder = () => useTabsStore.getState().tabs.map((tab) => tab.repoId);

beforeEach(() => {
  mockBackend.reset();
  queryClient.clear();
  for (const tab of useTabsStore.getState().tabs) closeTabAndRepo(tab.id);
  useTabsStore.setState({ closedTabs: [] });
  useWorkspaceUi.setState({ missing: null });
});

async function openThree(): Promise<void> {
  await openRepoPath(YAGGUI, useTabsStore.getState().activeTabId);
  await openRepoPath(LINUX);
  await openRepoPath(BLOG);
}

describe('reopenClosedTab', () => {
  it('brings the repository back at its former index and activates it', async () => {
    await openThree();
    const linuxTab = useTabsStore.getState().tabs[1]?.id ?? '';
    closeTabAndRepo(linuxTab);
    expect(repoOrder()).toEqual([1, 3]);
    expect(canReopenClosedTab()).toBe(true);

    await reopenClosedTab();
    expect(repoOrder()).toEqual([1, 2, 3]);
    expect(selectActiveTab(useTabsStore.getState()).repoId).toBe(2);
    expect(useRepoSessions.getState().sessions[2]?.status).toBe('open');
    expect(canReopenClosedTab()).toBe(false);
  });

  it('reopens tabs closed together one by one, pinned flag included', async () => {
    await openThree();
    const [first] = useTabsStore.getState().tabs;
    useTabsStore.getState().setPinned(useTabsStore.getState().tabs[2]?.id ?? '', true);
    expect(repoOrder()).toEqual([3, 1, 2]);
    closeTabsAndRepos(() => {
      useTabsStore.getState().closeTabsToRight(first?.id ?? '');
    });
    // The pinned tab stays.
    expect(repoOrder()).toEqual([3, 1]);
    closeTabAndRepo(useTabsStore.getState().tabs[0]?.id ?? '');
    expect(repoOrder()).toEqual([1]);

    await reopenClosedTab();
    expect(repoOrder()).toEqual([3, 1]);
    expect(useTabsStore.getState().tabs[0]?.pinned).toBe(true);
    await reopenClosedTab();
    expect(repoOrder()).toEqual([3, 1, 2]);
    expect(useTabsStore.getState().tabs[2]?.pinned).toBe(false);
  });

  it('uses the welcome tab left by closing the last tab', async () => {
    await openRepoPath(YAGGUI, useTabsStore.getState().activeTabId);
    closeTabAndRepo(useTabsStore.getState().activeTabId);
    expect(repoOrder()).toEqual([null]);
    await reopenClosedTab();
    expect(repoOrder()).toEqual([1]);
  });

  it('offers to locate a repository whose folder is gone', async () => {
    const tabs = useTabsStore.getState();
    // Repo 4 (legacy-api) is known but its folder no longer exists.
    tabs.setRepo(tabs.activeTabId, 4);
    closeTabAndRepo(tabs.activeTabId);
    await reopenClosedTab();
    expect(useWorkspaceUi.getState().missing).toEqual({ repoId: 4, workspaceId: null });
    expect(repoOrder()).toEqual([null]);
  });

  it('skips a repository removed from the recents since', async () => {
    await openThree();
    closeTabAndRepo(useTabsStore.getState().tabs[0]?.id ?? '');
    closeTabAndRepo(useTabsStore.getState().tabs[0]?.id ?? '');
    await mockBackend.commands.forgetRepo(2);
    queryClient.clear();
    await reopenClosedTab();
    expect(repoOrder()).toContain(1);
    expect(repoOrder()).not.toContain(2);
  });
});

describe('renameKnownRepo', () => {
  it('renames the repository everywhere and gives back the folder name when empty', async () => {
    await openRepoPath(YAGGUI, useTabsStore.getState().activeTabId);
    // What the welcome screen and the tabs read.
    const listed = await mockBackend.commands.listRepos();
    if (listed.status === 'ok') queryClient.setQueryData(['known-repos'], listed.data);
    const result = await renameKnownRepo(1, '  Main app ');
    expect(result.ok).toBe(true);
    const known = () =>
      queryClient
        .getQueryData<{ id: number; name: string }[]>(['known-repos'])
        ?.find((repo) => repo.id === 1);
    expect(known()?.name).toBe('Main app');
    expect(repoDisplayName(useRepoSessions.getState().sessions[1], undefined)).toBe('Main app');

    await renameKnownRepo(1, '');
    expect(repoDisplayName(useRepoSessions.getState().sessions[1], undefined)).toBe('yaggui');
  });

  it('refuses a name over 60 characters with a typed error', async () => {
    const result = await renameKnownRepo(1, 'x'.repeat(61));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalidArgument');
  });
});
