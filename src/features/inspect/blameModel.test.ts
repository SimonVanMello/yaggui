import { describe, expect, it } from 'vitest';

import type { BlameCommit } from '../../ipc';
import { AGE_STEPS, blameRows, chunkBounds } from './blameModel';

const commit = (authorTime: number, uncommitted = false): BlameCommit => ({
  sha: uncommitted ? '0'.repeat(40) : String(authorTime).padStart(40, 'a'),
  authorName: 'A',
  authorEmail: 'a@x',
  authorTime,
  summary: 's',
  path: 'f',
  previous: null,
  uncommitted,
});

describe('blameRows', () => {
  const commits = [commit(300), commit(100), commit(200), commit(0, true)];
  const chunks = [
    { start: 0, count: 2, commit: 1, sourceStart: 0 },
    { start: 2, count: 1, commit: 0, sourceStart: 4 },
    { start: 3, count: 2, commit: 1, sourceStart: 2 },
    { start: 5, count: 1, commit: 3, sourceStart: 5 },
  ];
  const rows = blameRows(6, commits, chunks);

  it('maps each line to its commit and marks chunk starts', () => {
    expect([...rows.commitOf]).toEqual([1, 1, 0, 1, 1, 3]);
    expect([...rows.chunkStart]).toEqual([1, 0, 1, 1, 0, 1]);
  });

  it('shades commits by date rank, uncommitted as the newest', () => {
    expect(rows.ageStep[1]).toBe(0);
    expect(rows.ageStep[0]).toBe(AGE_STEPS - 1);
    expect(rows.ageStep[2]).toBe(Math.round((AGE_STEPS - 1) / 2));
    expect(rows.ageStep[3]).toBe(AGE_STEPS - 1);
  });

  it('finds the chunk of a line, even next to a chunk of the same commit', () => {
    expect(chunkBounds(rows, 1)).toEqual([0, 1]);
    expect(chunkBounds(rows, 4)).toEqual([3, 4]);
    expect(chunkBounds(rows, 2)).toEqual([2, 2]);
  });

  it('tolerates chunks past the content', () => {
    const short = blameRows(1, [commit(1)], [{ start: 0, count: 5, commit: 0, sourceStart: 0 }]);
    expect([...short.commitOf]).toEqual([0]);
  });
});
