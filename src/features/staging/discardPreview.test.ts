import { describe, expect, it } from 'vitest';

import type { ChangedFile } from '../../ipc';
import { discardPreview, PREVIEW_LIMIT } from './discardPreview';

function file(path: string, status: ChangedFile['status']): ChangedFile {
  return {
    path,
    oldPath: null,
    status,
    similarity: null,
    additions: null,
    deletions: null,
    binary: false,
    oldMode: null,
    newMode: null,
  };
}

const note = (kind: 'delete' | 'revert') => kind;

describe('discard preview', () => {
  it('deletes untracked files and reverts tracked ones', () => {
    const preview = discardPreview(
      [file('a.ts', 'modified'), file('new.ts', 'untracked'), file('gone.ts', 'deleted')],
      note,
    );
    expect(preview.items).toEqual([
      { label: 'a.ts', note: 'revert', danger: false },
      { label: 'new.ts', note: 'delete', danger: true },
      { label: 'gone.ts', note: 'revert', danger: false },
    ]);
    expect(preview).toMatchObject({ deleted: 1, reverted: 2, more: 0 });
  });

  it('caps the list but counts every file', () => {
    const files = Array.from({ length: PREVIEW_LIMIT + 5 }, (_, i) =>
      file(`f${String(i)}`, i % 2 ? 'untracked' : 'modified'),
    );
    const preview = discardPreview(files, note);
    expect(preview.items).toHaveLength(PREVIEW_LIMIT);
    expect(preview.more).toBe(5);
    expect(preview.deleted + preview.reverted).toBe(PREVIEW_LIMIT + 5);
  });
});
