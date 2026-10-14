import { describe, expect, it } from 'vitest';

import { fuzzyMatch } from './fuzzy';

const rank = (query: string, texts: string[]) =>
  texts
    .map((text) => ({ text, match: fuzzyMatch(query, text) }))
    .filter((entry) => entry.match !== null)
    .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
    .map((entry) => entry.text);

describe('fuzzyMatch', () => {
  it('matches subsequences case-insensitively', () => {
    expect(fuzzyMatch('DAT', 'dataflows')?.indices).toEqual([0, 1, 2]);
    expect(fuzzyMatch('dfs', 'dataflows')).not.toBeNull();
    expect(fuzzyMatch('xyz', 'dataflows')).toBeNull();
  });

  it('accepts an empty query', () => {
    expect(fuzzyMatch('  ', 'yaggui')).toEqual({ score: 0, indices: [] });
  });

  it('prefers prefixes and word boundaries', () => {
    expect(rank('la', ['legacy-api', 'linux', 'lab'])).toEqual(['lab', 'legacy-api']);
    expect(rank('api', ['rapid', 'legacy-api'])[0]).toBe('legacy-api');
  });

  it('prefers consecutive characters', () => {
    expect(rank('yag', ['ya-git', 'yaggui'])[0]).toBe('yaggui');
  });

  it('highlights the boundary occurrence', () => {
    expect(fuzzyMatch('a', 'legacy-api')?.indices).toEqual([7]);
  });
});
