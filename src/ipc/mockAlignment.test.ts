import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Preferences } from './bindings';
import type { YagguiEventName } from './client';
import { DEFAULT_PREFERENCES } from '../app/preferences';
import { mockBackend, mockClient } from './mockClient';
import { unwrap } from './result';

/** Behaviors of the real backend the mock reproduces (M0-4 review of mock / real gaps). */
const { commands: mock } = mockClient;

beforeEach(() => {
  mockBackend.reset();
});

describe('mock aligned on the real backend', () => {
  it('rejects relative paths and reports missing folders', async () => {
    await expect(mock.openRepo('dev/yaggui')).resolves.toMatchObject({
      status: 'error',
      error: { code: 'invalidArgument' },
    });
    await expect(mock.openRepo('/Users/alex/missing-folder')).resolves.toMatchObject({
      status: 'error',
      error: { code: 'repoNotFound' },
    });
    await expect(mock.addSafeDirectory('relative')).resolves.toMatchObject({
      status: 'error',
      error: { code: 'invalidArgument' },
    });
  });

  it('opens the repository containing a subfolder', async () => {
    const info = await unwrap(mock.openRepo('/Users/alex/dev/yaggui/src/app/'));
    expect(info).toMatchObject({ id: 1, path: '/Users/alex/dev/yaggui', name: 'yaggui' });
  });

  it('refuses to favorite an unknown repository', async () => {
    await expect(mock.setRepoFavorite(999, true)).resolves.toMatchObject({
      status: 'error',
      error: { code: 'invalidArgument' },
    });
  });

  it('drops unknown repositories and stale active tabs from saved tabs', async () => {
    await unwrap(
      mock.saveTabs({
        tabs: [
          { id: 'a', repoId: 1, uiState: null },
          { id: 'b', repoId: 999, uiState: null },
        ],
        activeTabId: 'gone',
      }),
    );
    await expect(unwrap(mock.getTabs())).resolves.toEqual({
      tabs: [
        { id: 'a', repoId: 1, uiState: null },
        { id: 'b', repoId: null, uiState: null },
      ],
      activeTabId: null,
    });
  });

  it('turns the tabs of a forgotten repository into new tabs', async () => {
    await unwrap(
      mock.saveTabs({ tabs: [{ id: 'a', repoId: 3, uiState: null }], activeTabId: 'a' }),
    );
    await unwrap(mock.forgetRepo(3));
    const saved = await unwrap(mock.getTabs());
    expect(saved.tabs[0]?.repoId).toBeNull();
  });

  it('removes a stale lock through a maintenance operation and refuses a fresh one', async () => {
    vi.useFakeTimers();
    const seen: YagguiEventName[] = [];
    const names: YagguiEventName[] = ['opStarted', 'opFinished', 'statusChanged'];
    const unsubscribers = names.map((name) =>
      mockClient.events.subscribe(name, () => seen.push(name)),
    );
    await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    const path = '/Users/alex/dev/yaggui/.git/index.lock';
    mockBackend.setRepoState(1, { indexLock: { path, ageSecs: 1, stale: false } });
    seen.length = 0;
    await expect(mock.removeStaleIndexLock(1)).resolves.toMatchObject({
      status: 'error',
      error: { code: 'indexLocked', action: { kind: 'removeIndexLock', repoId: 1, path } },
    });
    expect(seen).toEqual(['opStarted', 'opFinished']);

    mockBackend.setRepoState(1, { indexLock: { path, ageSecs: 60, stale: true } });
    seen.length = 0;
    await unwrap(mock.removeStaleIndexLock(1));
    vi.runAllTimers();
    expect(seen).toEqual(['opStarted', 'opFinished', 'statusChanged']);
    await expect(unwrap(mock.repoState(1))).resolves.toMatchObject({ indexLock: null });
    unsubscribers.forEach((unsubscribe) => {
      unsubscribe();
    });
    vi.useRealTimers();
  });

  it('opens a terminal in an open repository only', async () => {
    await expect(mock.openTerminal(1)).resolves.toMatchObject({
      status: 'error',
      error: { code: 'repoNotOpen' },
    });
    await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    await expect(unwrap(mock.openTerminal(1))).resolves.toBe('open');
    expect(mockBackend.openedTerminals).toEqual([
      { repoId: 1, path: '/Users/alex/dev/yaggui', program: 'open' },
    ]);
  });

  it('uses the terminal preference and types a missing terminal', async () => {
    await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    await unwrap(
      mock.setPreferences({
        ...DEFAULT_PREFERENCES,
        theme: 'system',
        locale: null,
        terminal: '  kitty ',
        diffView: 'split',
      }),
    );
    await expect(unwrap(mock.getPreferences())).resolves.toMatchObject({
      terminal: 'kitty',
      diffView: 'split',
    });
    await expect(unwrap(mock.openTerminal(1))).resolves.toBe('kitty');

    await unwrap(
      mock.setPreferences({
        ...DEFAULT_PREFERENCES,
        theme: 'system',
        locale: null,
        terminal: 'missing-term',
        diffView: 'split',
      }),
    );
    await expect(mock.openTerminal(1)).resolves.toMatchObject({
      status: 'error',
      error: {
        code: 'terminalNotFound',
        action: { kind: 'configureTerminal' },
        message: { en: expect.stringContaining('missing-term') as unknown },
      },
    });
  });

  it('answers the folder picker with the queued folders, then a prompt', async () => {
    mockBackend.setPickedFolder('/Users/alex/dev/picked');
    mockBackend.setPickedFolder(null);
    await expect(unwrap(mock.pickRepoFolder('Choose'))).resolves.toBe('/Users/alex/dev/picked');
    await expect(unwrap(mock.pickRepoFolder('Choose'))).resolves.toBeNull();
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('  /Users/alex/typed  ');
    await expect(unwrap(mock.pickRepoFolder('Choose'))).resolves.toBe('/Users/alex/typed');
    expect(prompt).toHaveBeenCalledWith('Choose');
    prompt.mockRestore();
  });
});

describe('mock preferences feed the network commands', () => {
  const prefs = (patch: Partial<Preferences>) =>
    unwrap(mock.setPreferences({ ...DEFAULT_PREFERENCES, ...patch }));

  it('the pull default is the preference, else the Git config default', async () => {
    await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    await expect(unwrap(mock.pullDefaultStrategy(1))).resolves.toBe('ffOnly');
    await prefs({ pullStrategy: 'rebase' });
    await expect(unwrap(mock.pullDefaultStrategy(1))).resolves.toBe('rebase');
  });

  it('the protected branches come from the preference', async () => {
    await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    const preview = () => unwrap(mock.forcePushPreview(1, null));
    await prefs({ protectedBranches: ['feat/*'] });
    await expect(preview()).resolves.toMatchObject({ protected: true });
    await prefs({ protectedBranches: [] });
    await expect(preview()).resolves.toMatchObject({ protected: false });
  });
});

describe('mock clone, init and preferences aligned on the real backend (M2-7b)', () => {
  const init = (defaultBranch: string) =>
    mock.initRepo({ target: '/Users/alex/dev/new', defaultBranch, gitignore: [], readme: false });
  const clone = (url: string) =>
    mock.cloneRepo({
      cloneId: 'c1',
      url,
      target: '/Users/alex/dev/copy',
      branch: null,
      depth: null,
      recurseSubmodules: false,
    });

  it('init checks the branch name like git check-ref-format', async () => {
    for (const name of ['feat/', 'a.lock', 'x/.y', 'a//b', 'HEAD', 'a@{b', '.a', 'a\u0001b']) {
      await expect(init(name)).resolves.toMatchObject({
        status: 'error',
        error: { code: 'invalidRefName' },
      });
    }
    await expect(init('release/1.0')).resolves.toMatchObject({ status: 'ok' });
  });

  it('clone errors are the ones of the catalog', async () => {
    const error = async (url: string) => {
      const result = await clone(url);
      return result.status === 'error' ? result.error : null;
    };
    // Auth has no retry (the user signs in elsewhere), an unreachable host does.
    await expect(error('https://example.com/auth.git')).resolves.toMatchObject({
      code: 'authFailed',
      action: null,
      message: { en: expect.stringContaining('credential helper') as string },
    });
    await expect(error('https://x.unreachable/a.git')).resolves.toMatchObject({
      code: 'hostUnreachable',
      action: { kind: 'retry' },
    });
    await expect(error('https://example.com/notfound.git')).resolves.toMatchObject({
      code: 'remoteNotFound',
      message: { en: 'Remote not found: check its name and URL.' },
    });
  });

  it('preferences refuse control characters and more than 100 protected branches', async () => {
    const save = (patch: Partial<Preferences>) =>
      mock.setPreferences({ ...DEFAULT_PREFERENCES, ...patch });
    await expect(save({ uiFont: 'Inter\u0007' })).resolves.toMatchObject({ status: 'error' });
    await expect(save({ protectedBranches: ['a\u0000b'] })).resolves.toMatchObject({
      status: 'error',
    });
    const many = Array.from({ length: 101 }, (_, i) => `b${String(i)}`);
    await expect(save({ protectedBranches: many })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'invalidArgument' },
    });
    await expect(save({ protectedBranches: many.slice(1) })).resolves.toMatchObject({
      status: 'ok',
    });
  });
});
