import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_COLUMNS } from '../../features/graph/columns';
import { setNodeOpen } from '../../features/sidebar/sidebarUiState';
import { mockBackend } from '../../ipc/mockClient';
import { serializeTabUiState } from '../layout/panels';
import {
  DEFAULT_REPO_LAYOUT,
  loadRepoLayout,
  parseRepoLayout,
  persistRepoLayouts,
  resetStoredLayouts,
  serializeRepoLayout,
  type RepoLayout,
} from './repoLayout';
import { useTabsStore } from './tabsStore';

const DELAY = 300;

const LAYOUT: RepoLayout = {
  panels: { sidebar: { size: 300, collapsed: false }, details: { size: 400, collapsed: true } },
  sidebar: { open: { 'section:tags': false }, flat: true, recent: ['main'] },
  columns: { ...DEFAULT_COLUMNS, author: 200, hidden: { author: false, date: true, sha: false } },
};

async function knownRepoIds(): Promise<number[]> {
  const result = await mockBackend.commands.listRepos();
  if (result.status !== 'ok') throw new Error('listRepos failed');
  return result.data.map((repo) => repo.id);
}

async function saved(repoId: number): Promise<string | null> {
  const result = await mockBackend.commands.getRepoUiState(repoId);
  return result.status === 'ok' ? result.data : null;
}

beforeEach(() => {
  mockBackend.reset();
  resetStoredLayouts();
  useTabsStore.setState(useTabsStore.getInitialState());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('repo layout JSON', () => {
  it('round-trips and reads the same slices as a tab state', () => {
    expect(parseRepoLayout(serializeRepoLayout(LAYOUT))).toEqual(LAYOUT);
    const tabState = serializeTabUiState(LAYOUT.panels, {
      graph: { columns: LAYOUT.columns },
      sidebar: LAYOUT.sidebar,
    });
    expect(parseRepoLayout(tabState)).toEqual(LAYOUT);
  });

  it('falls back to the defaults on missing or broken data', () => {
    expect(parseRepoLayout(null)).toEqual(DEFAULT_REPO_LAYOUT);
    expect(parseRepoLayout('{oops')).toEqual(DEFAULT_REPO_LAYOUT);
  });
});

describe('loadRepoLayout', () => {
  it('reads the saved layout of a repository, the default one before any save', async () => {
    const [id] = await knownRepoIds();
    if (id === undefined) throw new Error('no known repo');
    expect(await loadRepoLayout(id)).toEqual(DEFAULT_REPO_LAYOUT);
    await mockBackend.commands.saveRepoUiState(id, serializeRepoLayout(LAYOUT));
    expect(await loadRepoLayout(id)).toEqual(LAYOUT);
  });
});

describe('persistRepoLayouts', () => {
  it('saves the layout of the repository whose tab changed, once settled', async () => {
    const [a, b] = await knownRepoIds();
    if (a === undefined || b === undefined) throw new Error('two known repos expected');
    vi.useFakeTimers();
    const tabs = useTabsStore.getState();
    const tabA = tabs.tabs[0]?.id ?? '';
    tabs.setRepo(tabA, a, LAYOUT);
    const tabB = tabs.newTab();
    tabs.setRepo(tabB, b);
    const stop = persistRepoLayouts(DELAY);

    // The tabs already open are carried over once.
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(parseRepoLayout(await saved(a))).toEqual(LAYOUT);
    expect(parseRepoLayout(await saved(b))).toEqual(DEFAULT_REPO_LAYOUT);

    tabs.updateSidebar(tabB, (state) => setNodeOpen(state, 'section:stashes', false));
    tabs.updateSidebar(tabB, (state) => setNodeOpen(state, 'section:remote', false));
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(parseRepoLayout(await saved(b)).sidebar.open).toEqual({});
    await vi.advanceTimersByTimeAsync(1);
    expect(parseRepoLayout(await saved(b)).sidebar.open).toEqual({
      'section:stashes': false,
      'section:remote': false,
    });
    tabs.setPanel(tabB, 'details', { size: 420 });
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(parseRepoLayout(await saved(b)).panels.details.size).toBe(420);
    // The other repository is untouched.
    expect(parseRepoLayout(await saved(a))).toEqual(LAYOUT);
    stop();
  });

  it('skips a layout that was just loaded', async () => {
    const [id] = await knownRepoIds();
    if (id === undefined) throw new Error('no known repo');
    await mockBackend.commands.saveRepoUiState(id, serializeRepoLayout(LAYOUT));
    const save = vi.spyOn(mockBackend.commands, 'saveRepoUiState');
    vi.useFakeTimers();
    const stop = persistRepoLayouts(DELAY);
    const layout = await loadRepoLayout(id);
    useTabsStore.getState().setRepo(useTabsStore.getState().tabs[0]?.id ?? '', id, layout);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(save).not.toHaveBeenCalled();
    stop();
  });
});

describe('closing a tab right after a change', () => {
  it('reopens the repository with that change, before its save delay', async () => {
    const [id] = await knownRepoIds();
    if (id === undefined) throw new Error('no known repo');
    vi.useFakeTimers();
    const stop = persistRepoLayouts(DELAY);
    const tabs = useTabsStore.getState();
    const tabId = tabs.tabs[0]?.id ?? '';
    tabs.setRepo(tabId, id, await loadRepoLayout(id));
    tabs.setColumns(tabId, LAYOUT.columns);
    tabs.closeTab(tabId);
    // No timer advanced: the save is still waiting when the repository is opened again.
    expect((await loadRepoLayout(id)).columns).toEqual(LAYOUT.columns);
    stop();
  });
});
