import { beforeEach, describe, expect, it } from 'vitest';

import {
  closeConflictView,
  conflictPathOf,
  conflictViewId,
  hasUnsavedConflictEdits,
  openConflictView,
  setConflictLeaveGuard,
  useConflictViewStore,
} from './conflictViewStore';

beforeEach(() => {
  useConflictViewStore.setState({ open: {} });
});

describe('conflict view', () => {
  it('names the view conflict:<path> and reads the path back', () => {
    expect(conflictViewId('src/app/App.tsx')).toBe('conflict:src/app/App.tsx');
    expect(conflictPathOf('conflict:src/app/App.tsx')).toBe('src/app/App.tsx');
    expect(conflictPathOf('diff:src/app/App.tsx')).toBeNull();
  });

  it('opens and closes the editor of a tab without touching the others', () => {
    void openConflictView('tab-1', { repoId: 1, path: 'a.ts' });
    void openConflictView('tab-2', { repoId: 2, path: 'b.ts' });
    closeConflictView('tab-1');
    expect(useConflictViewStore.getState().open['tab-1']).toBeUndefined();
    expect(useConflictViewStore.getState().open['tab-2']?.path).toBe('b.ts');
  });
});

describe('leaving a file with unsaved edits', () => {
  it('asks the guard before opening another file, not the same one', async () => {
    let asked = 0;
    let answer = false;
    setConflictLeaveGuard('tab-1', () => {
      asked++;
      return Promise.resolve(answer);
    });
    await openConflictView('tab-1', { repoId: 1, path: 'a.ts' });
    expect(asked).toBe(0);
    expect(await openConflictView('tab-1', { repoId: 1, path: 'b.ts' })).toBe(false);
    expect(useConflictViewStore.getState().open['tab-1']?.path).toBe('a.ts');
    answer = true;
    expect(await openConflictView('tab-1', { repoId: 1, path: 'b.ts' })).toBe(true);
    expect(asked).toBe(2);
    expect(await openConflictView('tab-1', { repoId: 1, path: 'c.ts' }, { force: true })).toBe(
      true,
    );
    expect(asked).toBe(2);
    setConflictLeaveGuard('tab-1', null);
  });

  it('tells the conflicts panel when a quick resolution would drop edits of the open file', async () => {
    await openConflictView('tab-1', { repoId: 1, path: 'a.ts' });
    expect(hasUnsavedConflictEdits('tab-1', { repoId: 1, path: 'a.ts' })).toBe(false);
    setConflictLeaveGuard('tab-1', () => Promise.resolve(true));
    expect(hasUnsavedConflictEdits('tab-1', { repoId: 1, path: 'a.ts' })).toBe(true);
    // Another file, another repo or another tab: nothing of the editor is at stake.
    expect(hasUnsavedConflictEdits('tab-1', { repoId: 1, path: 'b.ts' })).toBe(false);
    expect(hasUnsavedConflictEdits('tab-1', { repoId: 2, path: 'a.ts' })).toBe(false);
    expect(hasUnsavedConflictEdits('tab-2', { repoId: 1, path: 'a.ts' })).toBe(false);
    setConflictLeaveGuard('tab-1', null);
    expect(hasUnsavedConflictEdits('tab-1', { repoId: 1, path: 'a.ts' })).toBe(false);
  });
});
