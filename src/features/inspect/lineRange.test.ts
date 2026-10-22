import { describe, expect, it } from 'vitest';

import type { DiffHunk, LineHistoryEntry, TextDiff } from '../../ipc';
import { entrySpan, inSpan, spanOf } from './lineRange';

function hunk(newStart: number, newLines: number): DiffHunk {
  return {
    id: '',
    oldStart: newStart,
    oldLines: newLines,
    newStart,
    newLines,
    header: '',
    kinds: '',
    lines: [],
  };
}

function entry(hunks: DiffHunk[] | null): LineHistoryEntry {
  const diff: TextDiff | null = hunks && {
    hunks,
    additions: 0,
    deletions: 0,
    oldEncoding: 'utf8',
    newEncoding: 'utf8',
    oldLineEnding: 'lf',
    newLineEnding: 'lf',
    oldMissingNewline: false,
    newMissingNewline: false,
    oldLineCount: 0,
    newLineCount: 0,
  };
  return {
    sha: 'a'.repeat(40),
    parents: [],
    authorName: '',
    authorEmail: '',
    authorTime: 0,
    summary: '',
    path: 'a.txt',
    oldPath: null,
    status: 'modified',
    diff,
    origin: false,
  };
}

describe('line ranges', () => {
  it('turns two 0-based blame lines into a 1-based inclusive span', () => {
    expect(spanOf(4, 1)).toEqual({ start: 2, end: 5 });
    expect(spanOf(0, 0)).toEqual({ start: 1, end: 1 });
    expect(inSpan({ start: 2, end: 5 }, 1)).toBe(true);
    expect(inSpan({ start: 2, end: 5 }, 4)).toBe(true);
    expect(inSpan({ start: 2, end: 5 }, 5)).toBe(false);
    expect(inSpan(null, 0)).toBe(false);
  });

  it('reads where the range is in a commit from its hunks', () => {
    expect(entrySpan(entry([hunk(8, 2)]))).toEqual({ start: 8, end: 9 });
    expect(entrySpan(entry([hunk(3, 1), hunk(10, 4)]))).toEqual({ start: 3, end: 13 });
    // Every line removed, or a merge listed without a diff.
    expect(entrySpan(entry([hunk(4, 0)]))).toBeNull();
    expect(entrySpan(entry(null))).toBeNull();
  });
});
