import { describe, expect, it } from 'vitest';

import {
  adjacentConflict,
  buildResult,
  computeMerge,
  detectEol,
  splitLines,
  toggleChoice,
  withEol,
  type MergeModel,
} from './mergeModel';

const lines = (...l: string[]) => l.map((x) => `${x}\n`).join('');

function kinds(model: MergeModel) {
  return model.chunks.map((c) => c.kind);
}

function conflictTexts(model: MergeModel) {
  return model.conflicts.map((index) => {
    const chunk = model.chunks[index];
    if (!chunk) throw new Error('missing chunk');
    return {
      ours: model.ours.slice(chunk.ours.start, chunk.ours.end).join(''),
      theirs: model.theirs.slice(chunk.theirs.start, chunk.theirs.end).join(''),
    };
  });
}

describe('splitLines', () => {
  it('keeps terminators, including a last line without one', () => {
    expect(splitLines('a\r\nb\nc')).toEqual(['a\r\n', 'b\n', 'c']);
    expect(splitLines('a\n')).toEqual(['a\n']);
    expect(splitLines('')).toEqual([]);
  });
});

describe('detectEol', () => {
  it('picks the majority line ending', () => {
    expect(detectEol('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(detectEol('a\nb\n', 'c\r\n')).toBe('\n');
    expect(detectEol('no newline')).toBe('\n');
  });
});

describe('computeMerge', () => {
  it('merges changes of one side and keeps the rest', () => {
    const base = lines('a', 'b', 'c', 'd', 'e');
    const ours = lines('a', 'B', 'c', 'd', 'e');
    const theirs = lines('a', 'b', 'c', 'd', 'E', 'f');
    const model = computeMerge(base, ours, theirs);
    expect(kinds(model)).toEqual(['same', 'ours', 'same', 'theirs']);
    expect(model.conflicts).toEqual([]);
    expect(buildResult(model, []).text).toBe(lines('a', 'B', 'c', 'd', 'E', 'f'));
  });

  it('finds a conflict when both sides change the same lines', () => {
    const base = lines('a', 'b', 'c');
    const model = computeMerge(base, lines('a', 'ours', 'c'), lines('a', 'theirs', 'c'));
    expect(kinds(model)).toEqual(['same', 'conflict', 'same']);
    expect(conflictTexts(model)).toEqual([{ ours: 'ours\n', theirs: 'theirs\n' }]);
  });

  it('takes an identical change on both sides without conflict', () => {
    const base = lines('a', 'b', 'c');
    const model = computeMerge(base, lines('a', 'x', 'c'), lines('a', 'x', 'c'));
    expect(kinds(model)).toEqual(['same', 'both', 'same']);
    expect(buildResult(model, []).text).toBe(lines('a', 'x', 'c'));
  });

  it('makes changes on adjacent lines one conflict, as Git does', () => {
    const base = lines('a', 'b', 'c', 'd');
    const model = computeMerge(base, lines('a', 'B', 'c', 'd'), lines('a', 'b', 'C', 'd'));
    expect(model.conflicts).toHaveLength(1);
    expect(conflictTexts(model)).toEqual([{ ours: 'B\nc\n', theirs: 'b\nC\n' }]);
  });

  it('keeps conflicts separated by one unchanged line apart', () => {
    const base = lines('a', 'b', 'c', 'd', 'e');
    const model = computeMerge(
      base,
      lines('A1', 'b', 'c', 'D1', 'e'),
      lines('A2', 'b', 'c', 'D2', 'e'),
    );
    expect(kinds(model)).toEqual(['conflict', 'same', 'conflict', 'same']);
    const result = buildResult(model, [['ours'], ['theirs', 'ours']]);
    expect(result.text).toBe(lines('A1', 'b', 'c', 'D2', 'D1', 'e'));
    expect(result.regions).toEqual([
      { line: 0, count: 1 },
      { line: 3, count: 2 },
    ]);
  });

  it('trims the lines both sides share out of a conflict', () => {
    const base = lines('a', 'b');
    const model = computeMerge(
      base,
      lines('a', 'same', 'ours', 'tail'),
      lines('a', 'same', 'theirs', 'tail'),
    );
    expect(kinds(model)).toEqual(['same', 'both', 'conflict', 'both']);
    expect(conflictTexts(model)).toEqual([{ ours: 'ours\n', theirs: 'theirs\n' }]);
  });

  it('conflicts on a deletion against a modification', () => {
    const base = lines('a', 'b', 'c');
    const model = computeMerge(base, lines('a', 'c'), lines('a', 'B', 'c'));
    expect(conflictTexts(model)).toEqual([{ ours: '', theirs: 'B\n' }]);
    expect(buildResult(model, [['ours']]).text).toBe(lines('a', 'c'));
    expect(buildResult(model, [['theirs']]).text).toBe(lines('a', 'B', 'c'));
  });

  it('handles an add/add with no base: one conflict for what differs', () => {
    const model = computeMerge('', lines('x', 'ours'), lines('x', 'theirs'));
    expect(kinds(model)).toEqual(['both', 'conflict']);
    expect(conflictTexts(model)).toEqual([{ ours: 'ours\n', theirs: 'theirs\n' }]);
  });

  it('handles both sides appending at the end of the file', () => {
    const model = computeMerge(lines('a'), lines('a', 'x'), lines('a', 'y'));
    expect(kinds(model)).toEqual(['same', 'conflict']);
    expect(buildResult(model, [['ours', 'theirs']]).text).toBe(lines('a', 'x', 'y'));
  });

  it('keeps a missing final newline and adds one between joined pieces', () => {
    const model = computeMerge('a\nb', 'a\nours', 'a\ntheirs');
    expect(conflictTexts(model)).toEqual([{ ours: 'ours', theirs: 'theirs' }]);
    expect(buildResult(model, [['ours']]).text).toBe('a\nours');
    expect(buildResult(model, [['ours', 'theirs']]).text).toBe('a\nours\ntheirs');
    expect(buildResult(model, [['theirs', 'ours']]).text).toBe('a\ntheirs\nours');
  });

  it('sees a final line gaining a newline as a change of that line', () => {
    const model = computeMerge('a\nb', 'a\nb\n', 'a\nb');
    expect(kinds(model)).toEqual(['same', 'ours']);
    expect(buildResult(model, []).text).toBe('a\nb\n');
  });

  it('keeps CRLF line endings byte for byte', () => {
    const crlf = (...l: string[]) => l.map((x) => `${x}\r\n`).join('');
    const model = computeMerge(crlf('a', 'b', 'c'), crlf('a', 'O', 'c'), crlf('a', 'T', 'c'));
    expect(model.eol).toBe('\r\n');
    expect(buildResult(model, [['ours', 'theirs']]).text).toBe(crlf('a', 'O', 'T', 'c'));
  });

  it('uses the CRLF ending when joining a piece without one', () => {
    const model = computeMerge('a\r\nb', 'a\r\nO', 'a\r\nT');
    expect(buildResult(model, [['ours', 'theirs']]).text).toBe('a\r\nO\r\nT');
  });

  it('leaves an unresolved conflict empty and reports an empty region', () => {
    const model = computeMerge(lines('a', 'b', 'c'), lines('a', 'O', 'c'), lines('a', 'T', 'c'));
    expect(buildResult(model, []).text).toBe(lines('a', 'c'));
    expect(buildResult(model, []).regions).toEqual([{ line: 1, count: 0 }]);
  });

  it('rebuilds each version from its own ranges', () => {
    const base = lines('1', '2', '3', '4', '5', '6', '7', '8');
    const ours = lines('1', 'x', '3', '4', '5', '6', 'y', '8', '9');
    const theirs = lines('0', '1', '2', '3', 'z', '5', '6', '7', '8');
    const model = computeMerge(base, ours, theirs);
    for (const side of ['base', 'ours', 'theirs'] as const) {
      const rebuilt = model.chunks.map((c) => model[side].slice(c[side].start, c[side].end)).flat();
      expect(rebuilt).toEqual(model[side]);
    }
    expect(buildResult(model, []).text).toBe(
      lines('0', '1', 'x', '3', 'z', '5', '6', 'y', '8', '9'),
    );
  });

  it('merges 5,000-line files quickly', () => {
    const base = Array.from({ length: 5_000 }, (_, i) => `line ${String(i)}\n`);
    const ours = base.map((l, i) => (i % 50 === 0 ? `ours ${l}` : l));
    const theirs = base.map((l, i) => (i % 70 === 0 ? `theirs ${l}` : l));
    const start = performance.now();
    const model = computeMerge(base.join(''), ours.join(''), theirs.join(''));
    const elapsed = performance.now() - start;
    // Lines 0, 350, 700… are changed by both sides.
    expect(model.conflicts).toHaveLength(15);
    expect(elapsed).toBeLessThan(500);
  });
});

describe('choices', () => {
  it('toggles a side, keeping the order of choice', () => {
    expect(toggleChoice([], 'theirs')).toEqual(['theirs']);
    expect(toggleChoice(['theirs'], 'ours')).toEqual(['theirs', 'ours']);
    expect(toggleChoice(['theirs', 'ours'], 'theirs')).toEqual(['ours']);
  });

  it('moves between conflicts, wrapping around', () => {
    expect(adjacentConflict(0, null, 1)).toBeNull();
    expect(adjacentConflict(3, null, 1)).toBe(0);
    expect(adjacentConflict(3, null, -1)).toBe(2);
    expect(adjacentConflict(3, 2, 1)).toBe(0);
    expect(adjacentConflict(3, 0, -1)).toBe(2);
  });

  it('restores the line ending on save', () => {
    expect(withEol('a\nb\n', '\r\n')).toBe('a\r\nb\r\n');
    expect(withEol('a\nb', '\n')).toBe('a\nb');
  });
});
