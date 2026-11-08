import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MenuEntry, MenuSection, NativeMenu } from '../../ipc';

const install = vi.fn<NativeMenu['install']>();
const setEnabled = vi.fn<NativeMenu['setEnabled']>(() => Promise.resolve());

vi.mock('../../ipc', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../ipc')>();
  const fake: NativeMenu = { supported: true, install, setEnabled };
  return { ...original, nativeMenu: fake };
});

// Imported after the mock: the store modules reach `../../ipc` too.
const { installAppMenu, menuShortcuts, REPO_ITEMS } = await import('./appMenu');
const { queryClient, queryKeys } = await import('../queryClient');
const { useTabsStore } = await import('../tabs/tabsStore');

function recentLabels(sections: MenuSection[] | undefined): string[] {
  const file = sections?.[1]?.entries ?? [];
  const submenu = file.find((entry): entry is Extract<MenuEntry, { kind: 'submenu' }> => {
    return entry.kind === 'submenu';
  });
  return (submenu?.entries ?? []).flatMap((entry) =>
    entry.kind === 'action' ? [entry.label] : [],
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('menu shortcuts', () => {
  it('stay with the keyboard while the menu is not installed, or if installing failed', async () => {
    expect(menuShortcuts().size).toBe(0);
    install.mockRejectedValueOnce(new Error('menu unavailable'));
    await expect(installAppMenu()).rejects.toThrow('menu unavailable');
    expect(menuShortcuts().size).toBe(0);
  });

  it('move to the menu once it is installed', async () => {
    install.mockResolvedValueOnce(undefined);
    await installAppMenu();
    expect([...menuShortcuts()].sort()).toEqual(
      [
        'Mod+Alt+B',
        'Mod+Alt+I',
        'Mod+J',
        'Mod+O',
        'Mod+Shift+Z',
        'Mod+T',
        'Mod+W',
        'Mod+Z',
        // Repository menu.
        'Mod+Shift+F',
        'Mod+Shift+L',
        'Mod+Shift+P',
        'Mod+B',
        'Mod+Shift+S',
        'Mod+Shift+Alt+S',
        // View › zoom.
        'Mod+=',
        'Mod+-',
        'Mod+0',
      ].sort(),
    );
    // Tab numbers, ⌃Tab and the second zoom in key never leave the keyboard handler.
    expect(menuShortcuts().has('Mod+1')).toBe(false);
    expect(menuShortcuts().has('Ctrl+Tab')).toBe(false);
    expect(menuShortcuts().has('Mod+Shift+=')).toBe(false);
  });
});

describe('menu updates', () => {
  it('greys the Repository menu in and out with the active tab, without a rebuild', () => {
    install.mockClear();
    setEnabled.mockClear();
    const tabs = useTabsStore.getState();
    const welcome = tabs.activeTabId;
    const repoTab = tabs.newTab();
    useTabsStore.getState().setRepo(repoTab, 1, undefined);
    useTabsStore.getState().activate(repoTab);
    expect(setEnabled).toHaveBeenLastCalledWith(REPO_ITEMS, true);
    // Another change of the same kind sends nothing.
    useTabsStore.getState().setPanel(repoTab, 'sidebar', { collapsed: true });
    expect(setEnabled).toHaveBeenCalledTimes(1);
    useTabsStore.getState().activate(welcome);
    expect(setEnabled).toHaveBeenLastCalledWith(REPO_ITEMS, false);
    expect(install).not.toHaveBeenCalled();
  });

  it('rebuilds Open Recent once after a burst of known repository changes', async () => {
    vi.useFakeTimers();
    install.mockClear();
    install.mockResolvedValue(undefined);
    const repo = (id: number, name: string) => ({
      id,
      path: `/r/${name}`,
      name,
      favorite: false,
      lastOpenedAt: 100 + id,
      exists: true,
    });
    queryClient.setQueryData(queryKeys.knownRepos, [repo(1, 'one')]);
    queryClient.setQueryData(queryKeys.knownRepos, [repo(2, 'two'), repo(1, 'one')]);
    // A favorite star is not shown in the menu: no rebuild for it.
    queryClient.setQueryData(queryKeys.knownRepos, [
      { ...repo(2, 'two'), favorite: true },
      repo(1, 'one'),
    ]);
    expect(install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(install).toHaveBeenCalledTimes(1);
    expect(recentLabels(install.mock.calls[0]?.[0])).toEqual(['two', 'one']);
  });
});
