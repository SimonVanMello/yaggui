import { describe, expect, it } from 'vitest';

import { isLinkClick, isWebLink } from './terminalLinks';

function click(init: MouseEventInit): MouseEvent {
  return new MouseEvent('click', init);
}

describe('terminal links', () => {
  it('opens on ⌘-click on macOS and Ctrl-click elsewhere', () => {
    expect(isLinkClick(click({ metaKey: true }), 'mac')).toBe(true);
    expect(isLinkClick(click({ ctrlKey: true }), 'mac')).toBe(false);
    expect(isLinkClick(click({}), 'mac')).toBe(false);
    for (const platform of ['windows', 'linux'] as const) {
      expect(isLinkClick(click({ ctrlKey: true }), platform)).toBe(true);
      expect(isLinkClick(click({ metaKey: true }), platform)).toBe(false);
      expect(isLinkClick(click({}), platform)).toBe(false);
    }
  });

  it('only opens web links', () => {
    expect(isWebLink('https://github.com/a/b/pull/1')).toBe(true);
    expect(isWebLink('HTTP://localhost:5173/')).toBe(true);
    for (const uri of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'vscode://x',
      'https://',
      'https://a b',
    ]) {
      expect(isWebLink(uri)).toBe(false);
    }
  });
});
