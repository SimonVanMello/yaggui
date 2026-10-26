import { beforeEach, describe, expect, it } from 'vitest';

import { mockBackend, mockClient } from '../mockClient';
import { unwrap } from '../result';

const { commands: mock } = mockClient;

beforeEach(() => {
  mockBackend.reset();
});

/** `pull` (`src-tauri/src/repo/network.rs`): local changes the incoming commits would overwrite. */
describe('mock pull / backend parity', () => {
  it('refuses a pull that would overwrite local changes with `dirtyWorktree`', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/overwrite-pull'));
    mockBackend.setRepoState(id, {
      upstream: { name: 'origin/main', ahead: 0, behind: 2, gone: false },
    });
    const path = mockBackend.simulatePullOverwrite(id);
    expect(path).not.toBeNull();
    expect((await unwrap(mock.repoState(id))).dirty.unstaged).toBe(1);

    const refused = await mock.pull(id, null);
    expect(refused).toMatchObject({
      status: 'error',
      error: {
        code: 'dirtyWorktree',
        payload: { kind: 'dirtyWorktree', paths: [path], canCarry: false },
      },
    });
    if (refused.status !== 'error') return;
    expect(refused.error.detail).toContain('would be overwritten by merge');
    // Nothing moved: the branch is still behind.
    expect((await unwrap(mock.repoState(id))).upstream?.behind).toBe(2);
  });

  it('pulls over unrelated local changes, as the demo repositories do', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    expect(mockBackend.simulateEdit(id, 'notes/todo.md', 'x\n')).toBe(true);
    await expect(mock.pull(id, null)).resolves.toMatchObject({
      status: 'ok',
      data: { upToDate: false },
    });
  });
});
