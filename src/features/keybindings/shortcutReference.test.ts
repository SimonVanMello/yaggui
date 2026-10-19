import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerBuiltinActions } from '../palette/builtinActions';
import { registerBuiltinBindings } from './builtinBindings';
import { buildShortcutReference } from './shortcutReference';

let off: (() => void)[] = [];
beforeEach(() => {
  off = [registerBuiltinActions(), registerBuiltinBindings()];
});
afterEach(() => {
  for (const unregister of off) unregister();
});

describe('shortcut reference', () => {
  it('lists the defaults with macOS and Windows/Linux keycaps in both languages', () => {
    const entries = buildShortcutReference().groups.flatMap((group) => group.shortcuts);
    const palette = entries.find((entry) => entry.id === 'app.palette');
    expect(palette).toEqual({
      id: 'app.palette',
      title: { en: 'Open the command palette', fr: expect.any(String) as string },
      mac: ['⌘', 'K'],
      other: ['Ctrl', 'K'],
    });
    expect(entries.find((entry) => entry.id === 'edit.redoAlt')?.mac).toBeNull();
  });

  // Versioned with the docs, so each docs version shows the shortcuts of its own release.
  // `pnpm docs:shortcuts` rewrites the file; otherwise a stale file fails (part of `pnpm check`).
  it('matches website/src/content/docs/_data/shortcuts.json (run `pnpm docs:shortcuts`)', async () => {
    const json = `${JSON.stringify(buildShortcutReference(), null, 2)}\n`;
    await expect(json).toMatchFileSnapshot(
      '../../../website/src/content/docs/_data/shortcuts.json',
    );
  });
});
