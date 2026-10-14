import { describe, expect, it } from 'vitest';

import { sideCommit, sideName, sideNames, sideRole } from './sideLabels';

const commit = { sha: '0123456789abcdef', summary: 'Fix the parser' };

describe('side labels', () => {
  it('names a side after its branch, else its commit', () => {
    expect(sideName({ branch: 'feat/x', commit })).toBe('feat/x');
    expect(sideName({ branch: null, commit })).toBe('0123456');
    expect(sideName({ branch: null, commit: null })).toBeNull();
    expect(sideCommit({ branch: 'main', commit })).toBe('0123456 · Fix the parser');
    expect(
      sideNames(
        { ours: { branch: 'main', commit: null }, theirs: { branch: null, commit: null } },
        { ours: 'HEAD', theirs: 'theirs' },
      ),
    ).toEqual({ ours: 'main', theirs: 'theirs' });
  });

  it('gives each side its role in the operation, inverted in a rebase', () => {
    const merge = { kind: 'merge', squash: false } as const;
    const rebase = {
      kind: 'rebase',
      interactive: false,
      step: 1,
      total: 2,
      headName: 'feat/x',
    } as const;
    expect([sideRole(merge, 'ours'), sideRole(merge, 'theirs')]).toEqual(['current', 'merged']);
    expect([sideRole(rebase, 'ours'), sideRole(rebase, 'theirs')]).toEqual(['onto', 'replayed']);
    expect(sideRole({ kind: 'cherryPick' }, 'theirs')).toBe('picked');
    expect(sideRole({ kind: 'revert' }, 'theirs')).toBe('reverted');
    expect(sideRole(null, 'theirs')).toBe('other');
  });
});
