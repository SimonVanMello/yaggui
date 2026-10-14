import { describe, expect, it } from 'vitest';

import type { CleanupBranch } from '../../ipc';
import { cleanupCommand, cleanupEffect, defaultSelection } from './cleanupModel';

const branch = (name: string, merged: boolean, gone: boolean, unmerged: number): CleanupBranch => ({
  name,
  sha: '0'.repeat(40),
  merged,
  gone,
  upstream: gone ? `origin/${name}` : null,
  unmerged,
});

const branches = [
  branch('done', true, false, 0),
  branch('gone-merged', true, true, 0),
  branch('gone-work', false, true, 3),
];

describe('cleanup model', () => {
  it('preselects what loses no commit', () => {
    expect([...defaultSelection(branches)]).toEqual(['done', 'gone-merged']);
  });

  it('describes the effect of the selection', () => {
    expect(cleanupEffect(branches, new Set(['done', 'gone-work']))).toEqual({
      count: 2,
      merged: 1,
      gone: 1,
      unmergedCommits: 3,
    });
    expect(cleanupEffect(branches, new Set())).toEqual({
      count: 0,
      merged: 0,
      gone: 0,
      unmergedCommits: 0,
    });
  });

  it('shows the command', () => {
    expect(cleanupCommand(['a', 'b'])).toBe('git branch -D -- a b');
  });
});
