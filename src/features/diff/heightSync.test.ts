import { describe, expect, it } from 'vitest';

import { mergeSpacers, NO_SPACERS } from './heightSync';

const rows = (entries: [number, number][]) => new Map(entries);

describe('mergeSpacers', () => {
  it('pads the shorter side with the difference', () => {
    const merged = mergeSpacers(
      NO_SPACERS,
      rows([
        [0, 20],
        [1, 60],
        [2, 20],
      ]),
      rows([
        [0, 20],
        [1, 20],
        [2, 40],
      ]),
    );
    expect([...merged.a]).toEqual([[2, 20]]);
    expect([...merged.b]).toEqual([[1, 40]]);
  });

  it('returns the same object when nothing changes', () => {
    const first = mergeSpacers(NO_SPACERS, rows([[0, 40]]), rows([[0, 20]]));
    expect(mergeSpacers(first, rows([[0, 40]]), rows([[0, 20]]))).toBe(first);
    expect(mergeSpacers(NO_SPACERS, rows([[0, 20]]), rows([[0, 20.2]]))).toBe(NO_SPACERS);
  });

  it('drops a spacer once the rows are equal again (wrapping toggled off)', () => {
    const wrapped = mergeSpacers(NO_SPACERS, rows([[0, 60]]), rows([[0, 20]]));
    const flat = mergeSpacers(wrapped, rows([[0, 20]]), rows([[0, 20]]));
    expect(flat.a.size + flat.b.size).toBe(0);
  });

  it('moves the spacer to the other side when the taller side changes', () => {
    const first = mergeSpacers(NO_SPACERS, rows([[0, 60]]), rows([[0, 20]]));
    const flipped = mergeSpacers(first, rows([[0, 20]]), rows([[0, 60]]));
    expect(flipped.b.size).toBe(0);
    expect(flipped.a.get(0)).toBe(40);
  });

  it('keeps spacers of rows measured on one side only', () => {
    const first = mergeSpacers(NO_SPACERS, rows([[0, 60]]), rows([[0, 20]]));
    const scrolled = mergeSpacers(first, rows([[5, 20]]), rows([[6, 20]]));
    expect(scrolled.b.get(0)).toBe(40);
  });
});
