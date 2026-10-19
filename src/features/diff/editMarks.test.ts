import { describe, expect, it } from 'vitest';

import { editMarks, originalLines } from './editMarks';

const marks = (original: string | null, current: string) => {
  const result = editMarks(originalLines(original), current.split('\n'));
  return { added: [...result.added], removedBefore: [...result.removedBefore] };
};

describe('editMarks', () => {
  it('marks nothing on an unchanged file', () => {
    expect(marks('a\nb\n', 'a\nb\n')).toEqual({ added: [0, 0, 0], removedBefore: [] });
  });

  it('marks added and changed lines', () => {
    expect(marks('a\nb\nc\n', 'a\nB\nc\nd\n').added).toEqual([0, 1, 0, 1, 0]);
  });

  it('marks where lines were removed, at the end too', () => {
    expect(marks('a\nb\nc\n', 'a\nc\n').removedBefore).toEqual([1]);
    expect(marks('a\nb\n', 'a\n').removedBefore).toEqual([1]);
  });

  it('reads a CRLF index version line by line', () => {
    expect(marks('a\r\nb\r\n', 'a\nb\n').added).toEqual([0, 0, 0]);
  });

  it('marks every line of an untracked file', () => {
    expect(marks(null, 'x\ny').added).toEqual([1, 1]);
  });

  it('splits an index version without a final line break', () => {
    expect(marks('a\nb', 'a\nb\n').added).toEqual([0, 0, 0]);
    expect(originalLines('a\nb')).toEqual(['a', 'b']);
  });
});
