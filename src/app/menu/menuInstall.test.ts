import { describe, expect, it, vi } from 'vitest';

import type { NativeMenu } from '../../ipc';

const install = vi.fn<NativeMenu['install']>();

vi.mock('../../ipc', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../ipc')>();
  const fake: NativeMenu = { supported: true, install };
  return { ...original, nativeMenu: fake };
});

const { installAppMenu, menuShortcuts } = await import('./appMenu');

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
      ['Mod+Alt+B', 'Mod+Alt+I', 'Mod+J', 'Mod+O', 'Mod+Shift+Z', 'Mod+T', 'Mod+W', 'Mod+Z'].sort(),
    );
    // Tab numbers and ⌃Tab never leave the keyboard handler.
    expect(menuShortcuts().has('Mod+1')).toBe(false);
    expect(menuShortcuts().has('Ctrl+Tab')).toBe(false);
  });
});
