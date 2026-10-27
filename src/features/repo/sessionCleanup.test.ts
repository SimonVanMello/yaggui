import { beforeEach, describe, expect, it } from 'vitest';

import { queryClient } from '../../app/queryClient';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { ipc } from '../../ipc';
import { mockBackend } from '../../ipc/mockClient';
import { openCompare, useCompareStore } from '../compare/compareStore';
import { openConflictView, useConflictViewStore } from '../conflicts/conflictViewStore';
import { openDiff, useDiffStore } from '../diff/diffStore';
import { useStashPreview } from '../refs/stashPreview';
import { useCommitUi } from '../staging/commitUi';
import { useOpsStore } from './opsStore';
import { closeTabAndRepo, openRepoPath } from './repoSessions';

async function firstKnownPath(): Promise<string> {
  const result = await ipc.commands.listRepos();
  if (result.status !== 'ok' || !result.data[0]) throw new Error('a known repo is expected');
  return result.data[0].path;
}

beforeEach(() => {
  mockBackend.reset();
  queryClient.clear();
  for (const tab of useTabsStore.getState().tabs) closeTabAndRepo(tab.id);
});

describe('closing the tab of a repository forgets its UI state', () => {
  it('drops the comparison, stash preview, commit UI and last operation of the repository', async () => {
    const path = await firstKnownPath();
    await openRepoPath(path, useTabsStore.getState().activeTabId);
    const tab = useTabsStore.getState().tabs.find((t) => t.repoId !== null);
    const repoId = tab?.repoId ?? -1;
    expect(repoId).toBeGreaterThan(0);

    const sides = { a: { rev: 'main', label: 'main' }, b: { rev: 'dev', label: 'dev' } };
    openCompare(repoId, sides);
    openCompare(99, sides);
    useStashPreview.getState().show(repoId, {
      index: 0,
      name: 'stash@{0}',
      message: 'wip',
      sha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      untrackedSha: null,
      row: null,
    });
    useCommitUi.getState().setIdentity(repoId, true);
    useOpsStore.getState().finished(repoId, {
      opId: 1,
      kind: 'fetch',
      outcome: 'success',
      finishedAt: Date.now(),
    });
    useOpsStore.getState().finished(99, {
      opId: 2,
      kind: 'fetch',
      outcome: 'success',
      finishedAt: Date.now(),
    });

    closeTabAndRepo(tab?.id ?? '');

    expect(useCompareStore.getState().compare).toEqual({ 99: sides });
    expect(useStashPreview.getState().preview).toEqual({});
    expect(useCommitUi.getState().identity).toEqual({});
    expect(Object.keys(useOpsStore.getState().lastFinished)).toEqual(['99']);
  });
});

describe('closing a tab forgets what it showed', () => {
  it('drops the open diff and conflict editor of the closed tab only', async () => {
    const tabs = useTabsStore.getState();
    const closing = tabs.newTab();
    const kept = tabs.newTab();
    const selection = { repoId: 1, target: { kind: 'staged' as const }, path: 'a', oldPath: null };
    openDiff(closing, selection);
    openDiff(kept, selection);
    await openConflictView(closing, { repoId: 1, path: 'a' });
    await openConflictView(kept, { repoId: 1, path: 'a' });

    useTabsStore.getState().closeTab(closing);

    expect(Object.keys(useDiffStore.getState().open)).toEqual([kept]);
    expect(Object.keys(useConflictViewStore.getState().open)).toEqual([kept]);
  });
});
