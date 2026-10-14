import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commands, events } from './bindings';
import type { YagguiEventMap } from './client';
import { DEFAULT_PREFERENCES } from '../app/preferences';
import { mockBackend, mockClient } from './mockClient';
import { unwrap } from './result';

const { commands: mock } = mockClient;

beforeEach(() => {
  mockBackend.reset();
});
afterEach(() => vi.useRealTimers());

describe('mockClient', () => {
  it('implements every generated command', () => {
    expect(Object.keys(mock).sort()).toEqual(Object.keys(commands).sort());
  });

  it('returns app info', async () => {
    await expect(mock.appInfo()).resolves.toMatchObject({
      gitVersion: '2.47.1',
      gitSupported: true,
    });
  });

  it('lists recent repos, most recent first', async () => {
    const repos = await unwrap(mock.listRepos());
    expect(repos.map((repo) => repo.name)).toEqual(['yaggui', 'linux', 'blog', 'legacy-api']);
    expect(repos.find((repo) => repo.name === 'legacy-api')?.exists).toBe(false);
  });

  it('opens a repo and reads its state', async () => {
    const info = await unwrap(mock.openRepo('/Users/alex/dev/linux'));
    expect(info.state.operation).toMatchObject({ kind: 'rebase', step: 3, total: 7 });
    await expect(unwrap(mock.repoState(info.id))).resolves.toEqual(info.state);
  });

  it('keeps a session open until every tab closed it', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    await unwrap(mock.closeRepo(id));
    await expect(mock.repoState(id)).resolves.toMatchObject({ status: 'ok' });
    await unwrap(mock.closeRepo(id));
    await expect(mock.repoState(id)).resolves.toMatchObject({
      status: 'error',
      error: { code: 'repoNotOpen' },
    });
  });

  it('reports no watcher error by default', async () => {
    await expect(unwrap(mock.openRepo('/Users/alex/dev/yaggui'))).resolves.toMatchObject({
      watchError: null,
    });
  });

  it('returns typed errors', async () => {
    await expect(mock.openRepo('/tmp/not-a-repo')).resolves.toMatchObject({
      status: 'error',
      error: { code: 'notARepository' },
    });
    await expect(mock.repoState(1)).resolves.toMatchObject({
      status: 'error',
      error: { code: 'repoNotOpen' },
    });
  });

  it('persists tabs and preferences', async () => {
    const tabs = { tabs: [{ id: 't1', repoId: 1, uiState: '{"sidebar":240}' }], activeTabId: 't1' };
    await unwrap(mock.saveTabs(tabs));
    await expect(unwrap(mock.getTabs())).resolves.toEqual(tabs);

    await unwrap(
      mock.setPreferences({
        ...DEFAULT_PREFERENCES,
        theme: 'dark',
        locale: 'fr',
        terminal: null,
        diffView: 'split',
      }),
    );
    await expect(unwrap(mock.getPreferences())).resolves.toEqual({
      ...DEFAULT_PREFERENCES,
      theme: 'dark',
      locale: 'fr',
      terminal: null,
      diffView: 'split',
    });
  });

  it('migrates legacy preferences only once', async () => {
    await expect(
      unwrap(mock.migrateLegacyPreferences({ theme: 'light', locale: null })),
    ).resolves.toEqual({ ...DEFAULT_PREFERENCES, theme: 'light', checkUpdates: false });
    await expect(
      unwrap(mock.migrateLegacyPreferences({ theme: 'dark', locale: 'fr' })),
    ).resolves.toEqual({ ...DEFAULT_PREFERENCES, theme: 'light', checkUpdates: false });
  });
});

describe('mock events', () => {
  it('covers every generated event', () => {
    const names: (keyof YagguiEventMap)[] = [
      'commandLogged',
      'opStarted',
      'opProgress',
      'opFinished',
      'statusChanged',
      'refsChanged',
      'graphProgress',
      'cloneProgress',
      'journalChanged',
      'scanProgress',
      'ptyOutput',
      'ptyExited',
      'updateProgress',
    ];
    expect(names.sort()).toEqual(Object.keys(events).sort());
  });

  it('simulates an operation lifecycle', () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const unsubscribers = (
      ['opStarted', 'opProgress', 'opFinished', 'commandLogged', 'refsChanged'] as const
    ).map((name) => mockClient.events.subscribe(name, () => seen.push(name)));

    mockBackend.simulateOp(1, { stepMs: 10 });
    vi.runAllTimers();

    expect(seen[0]).toBe('opStarted');
    expect(seen.filter((name) => name === 'opProgress')).toHaveLength(6);
    expect(seen.slice(-3)).toEqual(['commandLogged', 'opFinished', 'refsChanged']);
    unsubscribers.forEach((unsubscribe) => {
      unsubscribe();
    });
  });

  it('cancels a running operation', async () => {
    vi.useFakeTimers();
    const outcomes: string[] = [];
    const unsubscribe = mockClient.events.subscribe('opFinished', (event) =>
      outcomes.push(event.outcome.kind),
    );
    const opId = mockBackend.simulateOp(1);
    await unwrap(mock.cancelOp(opId));
    vi.runAllTimers();
    expect(outcomes).toEqual(['cancelled']);
    unsubscribe();
  });

  it('stops delivering after unsubscribe', () => {
    const handler = vi.fn();
    const unsubscribe = mockClient.events.subscribe('statusChanged', handler);
    mockBackend.setRepoState(1, { dirty: { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 } });
    unsubscribe();
    mockBackend.setRepoState(1, { dirty: { staged: 0, unstaged: 2, untracked: 0, conflicted: 0 } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ repoId: 1 });
  });
});
