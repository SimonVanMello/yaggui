import { describe, expect, it } from 'vitest';

import type { ConflictSide, ConflictVersions } from '../../ipc';
import { choiceAction, isTextConflict, sideChange } from './choiceModel';

const text = (t: string): ConflictSide => ({ id: null, text: t, binary: false, size: t.length });
const binary: ConflictSide = { id: null, text: null, binary: true, size: 12 };
const labels = {
  ours: { branch: 'main', commit: null },
  theirs: { branch: 'feat', commit: null },
};

function versions(patch: Partial<ConflictVersions>): ConflictVersions {
  return {
    path: 'a.txt',
    kind: 'content',
    base: text('base\n'),
    ours: text('ours\n'),
    theirs: text('theirs\n'),
    merged: null,
    labels,
    ...patch,
  };
}

describe('choice model', () => {
  it('sends text content conflicts to the 3-way editor only', () => {
    expect(isTextConflict(versions({}))).toBe(true);
    expect(isTextConflict(versions({ kind: 'bothAdded', base: null }))).toBe(true);
    expect(isTextConflict(versions({ ours: binary }))).toBe(false);
    expect(isTextConflict(versions({ kind: 'deletedByThem', theirs: null }))).toBe(false);
    expect(isTextConflict(versions({ kind: null }))).toBe(false);
  });

  it('describes a deletion against a modification on both cards', () => {
    const deletedByThem = versions({ kind: 'deletedByThem', theirs: null });
    expect(sideChange(deletedByThem, 'ours')).toBe('modified');
    expect(sideChange(deletedByThem, 'theirs')).toBe('deleted');
    expect(choiceAction(deletedByThem, 'ours')).toBe('keepModified');
    expect(choiceAction(deletedByThem, 'theirs')).toBe('acceptDeletion');

    const deletedByUs = versions({ kind: 'deletedByUs', ours: null });
    expect(choiceAction(deletedByUs, 'ours')).toBe('acceptDeletion');
    expect(choiceAction(deletedByUs, 'theirs')).toBe('keepModified');
  });

  it('offers to keep or drop a file on one side, and a side of a binary', () => {
    const addedByUs = versions({ kind: 'addedByUs', base: null, theirs: null });
    expect(choiceAction(addedByUs, 'ours')).toBe('keepAdded');
    expect(choiceAction(addedByUs, 'theirs')).toBe('dropFile');
    const bin = versions({ base: binary, ours: binary, theirs: binary });
    expect(choiceAction(bin, 'ours')).toBe('take');
    expect(choiceAction(bin, 'theirs')).toBe('take');
  });
});
