import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { TextDiff } from '../../ipc';
import { CodeDiff } from './CodeDiff';

const diff: TextDiff = {
  hunks: [
    {
      id: '-1,3+1,3',
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      header: '',
      kinds: ' -+ ',
      lines: ['a', 'old', 'new', 'b'],
    },
  ],
  additions: 1,
  deletions: 1,
  oldEncoding: 'utf8',
  newEncoding: 'utf8',
  oldLineEnding: 'lf',
  newLineEnding: 'lf',
  oldMissingNewline: false,
  newMissingNewline: false,
  oldLineCount: 3,
  newLineCount: 3,
};

describe('CodeDiff', () => {
  it('keeps its editors when the parent re-renders with a new onHunks identity', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { container, rerender } = render(
      <CodeDiff diff={diff} view="unified" path="a.ts" worktree="unstaged" onHunks={first} />,
    );
    const editor = container.querySelector('.cm-editor');
    expect(editor).not.toBeNull();

    // A resize or a status event re-renders the diff view, which passes an inline arrow.
    rerender(
      <CodeDiff diff={diff} view="unified" path="a.ts" worktree="unstaged" onHunks={second} />,
    );
    expect(container.querySelector('.cm-editor')).toBe(editor);

    // The hunk actions still reach the handler of the latest render.
    const stage = container.querySelector<HTMLButtonElement>(
      '.yaggui-hunk-actions button[data-action="stage"]',
    );
    expect(stage).not.toBeNull();
    if (stage) fireEvent.click(stage);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
