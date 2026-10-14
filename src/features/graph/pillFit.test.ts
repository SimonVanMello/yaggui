import { describe, expect, it } from 'vitest';

import {
  fitPills,
  graphemes,
  MESSAGE_MIN_CH,
  MESSAGE_MIN_SHARE,
  pillArea,
  truncateMiddle,
  type PillInput,
} from './pillFit';

/** One unit per user-perceived character: budgets read as character counts. */
const chars = (text: string) => graphemes(text).length;

describe('graphemes', () => {
  it('keeps emoji sequences and combining marks whole', () => {
    expect(graphemes('a👨‍👩‍👧b')).toEqual(['a', '👨‍👩‍👧', 'b']);
    expect(graphemes('ét')).toEqual(['é', 't']);
    expect(graphemes('')).toEqual([]);
  });
});

describe('truncateMiddle', () => {
  it('returns the name unchanged when it fits, exactly or with room', () => {
    expect(truncateMiddle('main', 10, chars)).toBe('main');
    expect(truncateMiddle('feature/x', 9, chars)).toBe('feature/x');
  });

  it('keeps the leading segment and the end, on a word boundary', () => {
    expect(truncateMiddle('feature/PROJ-1234-login-timeout', 22, chars)).toBe(
      'feature/…login-timeout',
    );
    expect(truncateMiddle('origin/release/2.4', 12, chars)).toBe('origin/…/2.4');
  });

  it('never exceeds the budget', () => {
    const names = [
      'feature/PROJ-1234-login-timeout-on-slow-networks',
      'origin/release/2.4',
      'upstream/dependabot/npm_and_yarn/typescript-5.9.3',
      'averyveryverylongnamewithoutanyseparator',
      'users/aïcha/refactor-日本語-ブランチ-名前',
    ];
    for (const name of names) {
      for (let budget = 1; budget <= chars(name); budget++) {
        const out = truncateMiddle(name, budget, chars);
        expect(chars(out), `${name} @ ${String(budget)}`).toBeLessThanOrEqual(budget);
        if (budget < chars(name)) expect(out).toContain('…');
      }
    }
  });

  it('keeps a start and the end of a name without slash', () => {
    expect(truncateMiddle('PROJ-1234-login-timeout-on-slow-networks', 22, chars)).toBe(
      'PROJ-…on-slow-networks',
    );
  });

  it('drops a leading segment too long for the budget', () => {
    const out = truncateMiddle('averyveryverylongteamprefix/fix', 12, chars);
    expect(out).not.toContain('averyveryverylongteamprefix/');
    expect(out.endsWith('/fix')).toBe(true);
  });

  it('falls back to the end alone, then to the ellipsis, on tiny budgets', () => {
    expect(truncateMiddle('feature/login', 4, chars)).toBe('…gin');
    expect(truncateMiddle('feature/login', 1, chars)).toBe('…');
    expect(truncateMiddle('feature/login', 0, chars)).toBe('…');
  });

  it('cuts between graphemes, never inside one', () => {
    const name = 'feat/👨‍👩‍👧-family-👍🏽-ok';
    for (let budget = 2; budget < chars(name); budget++) {
      const out = truncateMiddle(name, budget, chars);
      for (const g of graphemes(out)) expect(graphemes(name).concat('…')).toContain(g);
    }
    expect(truncateMiddle('users/aïcha/refactor-日本語-ブランチ-名前', 16, chars)).toBe(
      'users/…ブランチ-名前',
    );
  });

  it('works with proportional widths', () => {
    // `i` narrow, `W` wide: the budget is in px, not characters.
    const width = (text: string) =>
      graphemes(text).reduce((sum, c) => sum + (c === 'W' ? 3 : c === 'i' ? 0.5 : 1), 0);
    const out = truncateMiddle('feature/WWWWWWWW-iiiiiiii', 16, width);
    expect(width(out)).toBeLessThanOrEqual(16);
    expect(out.startsWith('feature/…')).toBe(true);
    expect(out.endsWith('iiiiiiii')).toBe(true);
  });
});

describe('pillArea', () => {
  it('leaves the summary its share on a wide column', () => {
    expect(pillArea(1000, 7, 6)).toBe(1000 - 1000 * MESSAGE_MIN_SHARE - 6);
  });

  it('leaves the summary a minimum in ch on a narrow column, never below zero', () => {
    const narrow = (MESSAGE_MIN_CH * 7) / MESSAGE_MIN_SHARE - 10;
    expect(pillArea(narrow, 7, 6)).toBeCloseTo(narrow - MESSAGE_MIN_CH * 7 - 6);
    expect(pillArea(MESSAGE_MIN_CH * 7, 7, 6)).toBe(0);
  });

  it('gives the pills the room a short summary does not need', () => {
    expect(pillArea(1000, 7, 6, 150)).toBe(1000 - 150 - 6);
    expect(pillArea(1000, 7, 6, 900)).toBe(1000 - 1000 * MESSAGE_MIN_SHARE - 6);
  });
});

describe('fitPills', () => {
  const pill = (name: string): PillInput => ({ name, natural: name.length, chrome: 2 });
  const options = (available: number) => ({
    available,
    gap: 1,
    minName: 8,
    moreChip: (count: number) => 2 + String(count).length + 1,
  });

  it('shows every name in full when they fit', () => {
    const pills = [pill('main'), pill('origin/release/2.4')];
    expect(fitPills(pills, options(100))).toEqual({ shown: 2, budgets: [4, 18] });
    // Exact fit: 2 + 4 + 1 + 2 + 18.
    expect(fitPills(pills, options(27))).toEqual({ shown: 2, budgets: [4, 18] });
  });

  it('shrinks the longest names first and keeps short ones whole', () => {
    const pills = [pill('main'), pill('a'.repeat(30)), pill('b'.repeat(20))];
    // Names get 50 - 3 × 2 chrome - 2 gaps = 42: main 4, the two long ones 19 each.
    const fit = fitPills(pills, options(50));
    expect(fit.shown).toBe(3);
    expect(fit.budgets[0]).toBe(4);
    expect(fit.budgets[1]).toBeCloseTo(19, 0);
    expect(fit.budgets[2]).toBeCloseTo(19, 0);
    expect(fit.budgets.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(42);
  });

  it('only shrinks the longest when that is enough', () => {
    const pills = [pill('a'.repeat(10)), pill('b'.repeat(40))];
    const fit = fitPills(pills, options(40));
    expect(fit.budgets[0]).toBe(10);
    expect(fit.budgets[1]).toBeCloseTo(25, 0);
  });

  it('never goes below the minimum: folds pills into the chip instead', () => {
    const pills = [pill('a'.repeat(30)), pill('b'.repeat(30)), pill('c'.repeat(30))];
    // Three pills at the 8 minimum need 32; two and a 4-wide `+1` chip need 20 + 2 gaps + 4.
    const fit = fitPills(pills, options(26));
    expect(fit.shown).toBe(2);
    expect(fit.budgets.every((b) => b >= 8)).toBe(true);
  });

  it('shows only the chip when not even one pill fits', () => {
    const pills = [pill('a'.repeat(30)), pill('b'.repeat(30))];
    expect(fitPills(pills, options(5))).toEqual({ shown: 0, budgets: [] });
    expect(fitPills([], options(5))).toEqual({ shown: 0, budgets: [] });
  });

  it('never folds a lone ref into `+1`: it gets the room left, under the minimum', () => {
    expect(fitPills([pill('a'.repeat(30))], options(7))).toEqual({ shown: 1, budgets: [5] });
    expect(fitPills([pill('a'.repeat(30))], options(1))).toEqual({ shown: 1, budgets: [0] });
  });

  it('keeps a name shorter than the minimum whole even when squeezed', () => {
    const pills = [pill('v1'), pill('x'.repeat(40))];
    const fit = fitPills(pills, options(15));
    expect(fit.shown).toBe(2);
    expect(fit.budgets[0]).toBe(2);
    expect(fit.budgets[1]).toBe(8);
  });
});
