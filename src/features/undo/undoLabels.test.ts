import { describe, expect, it } from 'vitest';

import { blockMessage, opMessage, refList, shortRef } from './undoLabels';

describe('opMessage', () => {
  it('clips a long summary to its first line', () => {
    const message = opMessage({
      kind: 'commit',
      sha: 'a'.repeat(40),
      summary: `${'x'.repeat(80)}\nbody`,
    });
    expect(message.key).toBe('undo.op.commit');
    expect(String(message.params?.summary)).toHaveLength(60);
    expect(String(message.params?.summary).endsWith('…')).toBe(true);
  });

  it('tells a detached checkout from a branch checkout', () => {
    expect(opMessage({ kind: 'checkout', branch: 'main', sha: 'abcdef1234' }).key).toBe(
      'undo.op.checkout',
    );
    const detached = opMessage({ kind: 'checkout', branch: null, sha: 'abcdef1234' });
    expect(detached).toEqual({ key: 'undo.op.checkout.detached', params: { sha: 'abcdef1' } });
  });

  it('names the file of a single discard, counts otherwise', () => {
    expect(opMessage({ kind: 'discard', paths: ['a.ts'], count: 1 }).key).toBe(
      'undo.op.discard.file',
    );
    expect(opMessage({ kind: 'discard', paths: ['a.ts', 'b.ts'], count: 2 })).toEqual({
      key: 'undo.op.discard',
      params: { count: 2 },
    });
  });

  it('separates the deletion of a branch from that of its remote branch', () => {
    expect(opMessage({ kind: 'deleteBranch', name: 'x', remote: true }).key).toBe(
      'undo.op.deleteBranch.remote',
    );
  });
});

describe('blockMessage', () => {
  it('has a message for every reason', () => {
    for (const kind of ['published', 'pruned', 'pulled', 'notRecorded'] as const) {
      expect(blockMessage({ kind }).key).toBe(`undo.blocked.${kind}`);
    }
    expect(blockMessage({ kind: 'diverged', refs: ['refs/heads/main', 'HEAD'] })).toEqual({
      key: 'undo.blocked.diverged',
      params: { refs: 'main, HEAD' },
    });
  });
});

describe('refs', () => {
  it('shortens full names', () => {
    expect(shortRef('refs/heads/feat/x')).toBe('feat/x');
    expect(shortRef('refs/tags/v1')).toBe('v1');
    expect(shortRef('HEAD')).toBe('HEAD');
    expect(refList(['refs/heads/a', 'refs/tags/b'])).toBe('a, b');
  });
});
