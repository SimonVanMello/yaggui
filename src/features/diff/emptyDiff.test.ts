import { describe, expect, it } from 'vitest';

import type { FileDiff, TextDiff } from '../../ipc';
import { emptyDiffReason } from './emptyDiff';

function text(patch: Partial<TextDiff> = {}): FileDiff['content'] {
  const diff: TextDiff = {
    hunks: [],
    additions: 0,
    deletions: 0,
    oldLineEnding: 'lf',
    newLineEnding: 'lf',
    oldEncoding: 'utf8',
    newEncoding: 'utf8',
    oldMissingNewline: false,
    newMissingNewline: false,
    oldLineCount: 3,
    newLineCount: 3,
    ...patch,
  };
  return { kind: 'text', ...diff };
}

function diff(patch: Partial<FileDiff>): FileDiff {
  return {
    path: 'a.sh',
    oldPath: null,
    oldId: 'a',
    newId: 'b',
    oldMode: 'regular',
    newMode: 'regular',
    content: text(),
    ...patch,
  };
}

describe('emptyDiffReason', () => {
  it('names a mode-only change', () => {
    expect(emptyDiffReason(diff({ newMode: 'executable', oldId: 'a', newId: 'a' }), false)).toEqual(
      { kind: 'mode', from: 'regular', to: 'executable' },
    );
  });

  it('names line endings or whitespace hidden by the option', () => {
    const eol = diff({ content: text({ oldLineEnding: 'lf', newLineEnding: 'crlf' }) });
    expect(emptyDiffReason(eol, true)).toEqual({ kind: 'lineEndings' });
    expect(emptyDiffReason(diff({}), true)).toEqual({ kind: 'whitespace' });
  });

  it('says nothing changed otherwise', () => {
    expect(emptyDiffReason(diff({ oldId: 'a', newId: 'a' }), true)).toEqual({ kind: 'none' });
    expect(emptyDiffReason(diff({}), false)).toEqual({ kind: 'none' });
  });
});
