import { describe, expect, it } from 'vitest';

import { intralineDiff, tokenize } from './intraline';

const slice = (text: string, ranges: { from: number; to: number }[]) =>
  ranges.map((r) => text.slice(r.from, r.to));

describe('intraline diff', () => {
  it('splits words, spaces and punctuation', () => {
    expect(tokenize('const a = foo(1);')).toEqual([
      'const',
      ' ',
      'a',
      ' ',
      '=',
      ' ',
      'foo',
      '(',
      '1',
      ')',
      ';',
    ]);
    expect(tokenize('café crème')).toEqual(['café', ' ', 'crème']);
  });

  it('highlights only the changed words', () => {
    const old = '    <div className={styles.bar}>';
    const now = '    <div className={styles.bar} {...drag.containerProps}>';
    const ranges = intralineDiff(old, now);
    expect(ranges?.old).toEqual([]);
    expect(slice(now, ranges?.new ?? [])).toEqual([' {...drag.containerProps}']);
  });

  it('marks replaced words on both sides', () => {
    const ranges = intralineDiff('export const a = 1;', 'export const a = 2;');
    expect(ranges).toEqual({ old: [{ from: 17, to: 18 }], new: [{ from: 17, to: 18 }] });
  });

  it('gives up on unrelated or very long lines', () => {
    expect(intralineDiff('return items.map(render);', 'throw new Error("nope")')).toBeNull();
    expect(intralineDiff('x'.repeat(2000), 'y'.repeat(2000))).toBeNull();
  });
});
