import { describe, expect, it } from 'vitest';

import type { ChangedFile, TextDiff } from '../../ipc';
import {
  adjacentFile,
  adjacentStop,
  changeStarts,
  hunkTitle,
  splitModel,
  unifiedModel,
} from './diffModel';

function textDiff(patch: Partial<TextDiff>): TextDiff {
  return {
    hunks: [],
    additions: 0,
    deletions: 0,
    oldEncoding: 'utf8',
    newEncoding: 'utf8',
    oldLineEnding: 'lf',
    newLineEnding: 'lf',
    oldMissingNewline: false,
    newMissingNewline: false,
    oldLineCount: 10,
    newLineCount: 11,
    ...patch,
  };
}

const diff = textDiff({
  hunks: [
    {
      id: '-2,4+2,5',
      oldStart: 2,
      oldLines: 4,
      newStart: 2,
      newLines: 5,
      header: 'function f() {',
      kinds: ' --++ +',
      lines: ['a', 'const x = 1;', 'gone', 'const x = 2;', 'added', 'b', 'tail'],
    },
  ],
});

describe('diff model', () => {
  it('numbers unified lines from the hunk starts', () => {
    const { lines, hunks } = unifiedModel(diff);
    expect(hunks[0]?.title).toBe('@@ -2,4 +2,5 @@ function f() {');
    expect(lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ['context', 2, 2],
      ['del', 3, null],
      ['del', 4, null],
      ['add', null, 3],
      ['add', null, 4],
      ['context', 5, 5],
      ['add', null, 6],
    ]);
  });

  it('pairs removed and added lines for word highlights', () => {
    const { lines } = unifiedModel(diff);
    expect(lines[1]?.marks).toEqual([{ from: 10, to: 11 }]);
    expect(lines[3]?.marks).toEqual([{ from: 10, to: 11 }]);
    // `gone` / `added` share nothing: no word highlight.
    expect(lines[2]?.marks).toEqual([]);
  });

  it('aligns both columns with fillers in split mode', () => {
    const { left, right } = splitModel(diff);
    expect(left).toHaveLength(right.length);
    expect(left.map((l) => l.kind)).toEqual(['context', 'del', 'del', 'context', 'empty']);
    expect(right.map((l) => l.kind)).toEqual(['context', 'add', 'add', 'context', 'add']);
    expect(right.map((l) => l.newNo)).toEqual([2, 3, 4, 5, 6]);
  });

  it('flags the line missing its final newline', () => {
    const d = textDiff({
      oldLineCount: 1,
      newLineCount: 1,
      oldMissingNewline: true,
      hunks: [
        {
          id: 'h',
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          header: '',
          kinds: '-+',
          lines: ['x', 'x'],
        },
      ],
    });
    expect(unifiedModel(d).lines.map((l) => l.noNewline)).toEqual([true, false]);
  });

  it('formats a hunk title without section', () => {
    const hunk = diff.hunks[0];
    if (!hunk) throw new Error('fixture');
    expect(hunkTitle({ ...hunk, header: '' })).toBe('@@ -2,4 +2,5 @@');
  });
});

describe('navigation', () => {
  it('stops at each run of changes', () => {
    const { lines } = unifiedModel(diff);
    const stops = changeStarts(lines);
    expect(stops).toEqual([1, 6]);
    expect(adjacentStop(stops, null, 1)).toBe(1);
    expect(adjacentStop(stops, null, -1)).toBeNull();
    expect(adjacentStop(stops, 1, 1)).toBe(6);
    expect(adjacentStop(stops, 6, 1)).toBeNull();
    expect(adjacentStop(stops, 6, -1)).toBe(1);
    expect(adjacentStop([], 0, 1)).toBeNull();
  });

  it('moves between files without wrapping', () => {
    const file = (path: string): ChangedFile => ({
      path,
      oldPath: null,
      status: 'modified',
      similarity: null,
      additions: 1,
      deletions: 0,
      binary: false,
      oldMode: 'regular',
      newMode: 'regular',
    });
    const files = [file('a'), file('b'), file('c')];
    expect(adjacentFile(files, 'b', 1)?.path).toBe('c');
    expect(adjacentFile(files, 'b', -1)?.path).toBe('a');
    expect(adjacentFile(files, 'c', 1)).toBeNull();
    expect(adjacentFile(files, 'zz', 1)?.path).toBe('a');
  });
});
