import { afterEach, describe, expect, it, vi } from 'vitest';

import { queryClient, queryKeys } from '../../app/queryClient';
import type { BisectState, RepoState } from '../../ipc';
import { useGraphNavigation } from '../repo/graphNavigation';
import { bisectMarkTarget } from './bisectActions';

let active: number | null = 1;
vi.mock('../repo/repoSessions', async (original) => ({
  ...(await original<typeof import('../repo/repoSessions')>()),
  activeRepoId: () => active,
}));

function setOperation(kind: 'bisect' | 'merge' | null): void {
  queryClient.setQueryData<Partial<RepoState>>(queryKeys.repoState(1), {
    operation: kind === null ? null : { kind },
  } as Partial<RepoState>);
}

function bisect(partial: Partial<BisectState>): void {
  queryClient.setQueryData<BisectState>(queryKeys.bisectState(1), {
    bad: 'b',
    good: ['g'],
    skipped: [],
    current: { sha: 'c', summary: 'c', authorName: 'Alex', authorTime: 0 },
    awaitingCheckout: false,
    remaining: 3,
    steps: 1,
    result: null,
    original: 'main',
    firstParent: false,
    ...partial,
  });
}

afterEach(() => {
  active = 1;
  queryClient.clear();
  useGraphNavigation.setState({ selected: {} });
});

describe('bisect palette actions', () => {
  it('start from the selected commit, only with nothing else in progress', () => {
    setOperation(null);
    expect(bisectMarkTarget('good')).toEqual({ reason: 'palette.disabled.noCommit' });
    useGraphNavigation.setState({ selected: { 1: 'abc' } });
    expect(bisectMarkTarget('bad')).toEqual({ repoId: 1, rev: 'abc' });
    // Skip has nothing to skip before a bisect.
    expect(bisectMarkTarget('skip')).toEqual({ reason: 'palette.disabled.noBisect' });
    setOperation('merge');
    expect(bisectMarkTarget('good')).toEqual({ reason: 'palette.disabled.operationRunning' });
    active = null;
    expect(bisectMarkTarget('good')).toEqual({ reason: 'palette.disabled.noRepo' });
  });

  it('mark the commit under test during a bisect, whatever is selected', () => {
    setOperation('bisect');
    useGraphNavigation.setState({ selected: { 1: 'abc' } });
    bisect({});
    expect(bisectMarkTarget('good')).toEqual({ repoId: 1, rev: null });
    expect(bisectMarkTarget('skip')).toEqual({ repoId: 1, rev: null });
    // Nothing to mark once the result is known, or while the next commit is not checked out.
    bisect({ awaitingCheckout: true });
    expect(bisectMarkTarget('bad')).toEqual({ reason: 'palette.disabled.bisectNoCommit' });
    bisect({
      result: { kind: 'found', commit: { sha: 'b', summary: 'b', authorName: 'A', authorTime: 0 } },
    });
    expect(bisectMarkTarget('good')).toEqual({ reason: 'palette.disabled.bisectNoCommit' });
  });
});
