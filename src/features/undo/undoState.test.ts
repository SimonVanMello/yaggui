import { describe, expect, it } from 'vitest';

import type { JournalEntry, UndoBlock, UndoState, UndoStep } from '../../ipc';
import { buttonState, canRun } from './undoState';

function step(blocked: UndoBlock | null = null): UndoStep {
  const entry: JournalEntry = {
    id: 1,
    op: { kind: 'commit', sha: 'abc', summary: 'feat: x' },
    at: 0,
    undone: false,
    blocked,
  };
  return { entry, blocked };
}

describe('buttonState', () => {
  it('is empty with no step, or before the state is loaded', () => {
    expect(buttonState(undefined, 'undo').kind).toBe('empty');
    expect(buttonState({ undo: null, redo: null }, 'redo').kind).toBe('empty');
  });

  it('is ready for an unblocked step', () => {
    const state: UndoState = { undo: step(), redo: null };
    expect(buttonState(state, 'undo').kind).toBe('ready');
    expect(buttonState(state, 'redo').kind).toBe('empty');
  });

  it.each<UndoBlock>([
    { kind: 'published' },
    { kind: 'pruned' },
    { kind: 'pulled' },
    { kind: 'notRecorded' },
    { kind: 'diverged', refs: ['refs/heads/main'] },
  ])('is blocked for $kind', (block) => {
    expect(buttonState({ undo: step(block), redo: null }, 'undo').kind).toBe('blocked');
  });
});

describe('canRun', () => {
  it('lets a command through while the state is unknown, so the backend answers', () => {
    expect(canRun(undefined, 'undo')).toBe(true);
  });

  it('only runs a ready step', () => {
    expect(canRun({ undo: step(), redo: null }, 'undo')).toBe(true);
    expect(canRun({ undo: null, redo: null }, 'undo')).toBe(false);
    expect(canRun({ undo: step({ kind: 'published' }), redo: null }, 'undo')).toBe(false);
  });
});
