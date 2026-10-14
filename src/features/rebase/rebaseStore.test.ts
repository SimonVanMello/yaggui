import { afterEach, describe, expect, it } from 'vitest';

import {
  chooseRebaseBase,
  closeInteractiveRebase,
  openInteractiveRebase,
  setRebaseRows,
  setRebaseStop,
  useRebaseStore,
} from './rebaseStore';

const session = (repoId: number) => useRebaseStore.getState().sessions[repoId];

afterEach(() => {
  useRebaseStore.setState({ sessions: {} });
});

describe('interactive rebase sessions', () => {
  it('opens without a base for the picker, then takes the chosen one', () => {
    openInteractiveRebase(1, null);
    expect(session(1)).toEqual({ base: null, rows: null, stop: null });
    chooseRebaseBase(1, 'abc');
    expect(session(1)?.base).toBe('abc');
  });

  it('keeps the edits when opened again with the same base, starts over for another', () => {
    openInteractiveRebase(1, 'abc');
    setRebaseRows(1, []);
    openInteractiveRebase(1, 'abc');
    expect(session(1)?.rows).toEqual([]);
    openInteractiveRebase(1, 'def');
    expect(session(1)).toEqual({ base: 'def', rows: null, stop: null });
  });

  it('is per repository and closes one at a time', () => {
    openInteractiveRebase(1, 'a');
    openInteractiveRebase(2, 'b');
    setRebaseStop(2, { kind: 'conflicts' });
    closeInteractiveRebase(1);
    expect(session(1)).toBeUndefined();
    expect(session(2)?.stop).toEqual({ kind: 'conflicts' });
    // Writing to a closed session does nothing.
    setRebaseRows(1, []);
    expect(session(1)).toBeUndefined();
  });
});
