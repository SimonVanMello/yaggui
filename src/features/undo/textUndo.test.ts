import { afterEach, describe, expect, it, vi } from 'vitest';

import { forwardToTextEntry } from './textUndo';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('forwardToTextEntry', () => {
  it('does nothing outside a text field', () => {
    document.body.innerHTML = '<button id="b"></button>';
    expect(forwardToTextEntry('undo', document.querySelector('#b'))).toBe(false);
  });

  it('replays the key press in a code editor, shifted for redo', () => {
    document.body.innerHTML =
      '<div class="cm-editor"><div class="cm-content" contenteditable="true"></div></div>';
    const content = document.querySelector('.cm-content');
    if (!content) throw new Error('no editor');
    const seen: KeyboardEvent[] = [];
    content.addEventListener('keydown', (event) => seen.push(event as KeyboardEvent));
    expect(forwardToTextEntry('undo', content)).toBe(true);
    expect(forwardToTextEntry('redo', content)).toBe(true);
    expect(seen.map((e) => [e.key, e.metaKey, e.shiftKey])).toEqual([
      ['z', true, false],
      ['z', true, true],
    ]);
  });

  it('uses the editing command of a native input', () => {
    document.body.innerHTML = '<input id="i">';
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    expect(forwardToTextEntry('undo', document.querySelector('#i'))).toBe(true);
    expect(exec).toHaveBeenCalledWith('undo');
  });
});
