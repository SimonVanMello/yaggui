import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockBackend, mockClient } from '../mockClient';
import { unwrap, type IpcResult } from '../result';
import { MOVED_CODEMIRROR_HEAD } from './modules';

const { commands: mock } = mockClient;
const YAGGUI = '/Users/alex/dev/yaggui';

async function open(): Promise<number> {
  return (await unwrap(mock.openRepo(YAGGUI))).id;
}

/** Runs a queued mock write to its end (its delay is simulated with timers). */
async function settle<T>(promise: Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  await vi.advanceTimersByTimeAsync(2_000);
  return promise;
}

beforeEach(() => {
  mockBackend.reset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

/** Same behavior as `repo/modules.rs` (see `src-tauri/tests/modules.rs`). */
describe('mock submodules', () => {
  it('reports moved, modified and uninitialized submodules', async () => {
    const id = await open();
    const status = await unwrap(mock.submoduleStatus(id));
    expect(status.map((s) => s.path)).toEqual(['docs/theme', 'vendor/codemirror']);
    const [theme, codemirror] = status;
    expect(theme).toMatchObject({ initialized: false, head: null, dirty: false });
    expect(codemirror).toMatchObject({
      initialized: true,
      head: MOVED_CODEMIRROR_HEAD,
      dirty: true,
      absolutePath: `${YAGGUI}/vendor/codemirror`,
    });
    expect(codemirror?.expected).not.toBe(MOVED_CODEMIRROR_HEAD);
  });

  it('updates, with --init for the uninitialized ones', async () => {
    const id = await open();
    await unwrap(settle(mock.updateSubmodules(id, { paths: [], init: false, recursive: false })));
    let status = await unwrap(mock.submoduleStatus(id));
    expect(status.find((s) => s.path === 'vendor/codemirror')?.head).toBe(
      status.find((s) => s.path === 'vendor/codemirror')?.expected,
    );
    expect(status.find((s) => s.path === 'docs/theme')?.initialized).toBe(false);

    await unwrap(
      settle(mock.updateSubmodules(id, { paths: ['docs/theme'], init: true, recursive: true })),
    );
    status = await unwrap(mock.submoduleStatus(id));
    expect(status.every((s) => s.initialized && s.head === s.expected)).toBe(true);
    const refs = await unwrap(mock.listRefs(id));
    expect(refs.submodules.every((s) => s.initialized)).toBe(true);

    await expect(
      settle(mock.updateSubmodules(id, { paths: ['nope'], init: false, recursive: false })),
    ).resolves.toMatchObject({ status: 'error', error: { code: 'invalidArgument' } });
  });

  it('opens an initialized submodule as its own repository', async () => {
    const id = await open();
    await unwrap(mock.listRefs(id));
    const sub = await unwrap(mock.openRepo(`${YAGGUI}/vendor/codemirror`));
    expect(sub.id).not.toBe(id);
    // An ordinary folder of the worktree still opens the repository itself.
    expect((await unwrap(mock.openRepo(`${YAGGUI}/src`))).id).toBe(id);
  });
});

describe('mock worktrees', () => {
  it('creates a worktree on a new branch and refuses a branch checked out elsewhere', async () => {
    const id = await open();
    const path = await unwrap(
      settle(
        mock.createWorktree(id, {
          path: `${YAGGUI}-hotfix`,
          branch: { kind: 'new', name: 'hotfix/login', start: 'main' },
        }),
      ),
    );
    const refs = await unwrap(mock.listRefs(id));
    expect(refs.worktrees.map((w) => w.path)).toContain(path);
    expect(refs.local.map((b) => b.name)).toContain('hotfix/login');

    const review = refs.worktrees.find((w) => w.path === `${YAGGUI}-review`);
    const busy = review?.head?.kind === 'branch' ? review.head.name : '';
    await expect(
      settle(
        mock.createWorktree(id, { path: `${YAGGUI}-x`, branch: { kind: 'existing', name: busy } }),
      ),
    ).resolves.toMatchObject({ status: 'error', error: { code: 'branchInOtherWorktree' } });
    await expect(
      settle(mock.checkout(id, { kind: 'branch', name: busy }, 'clean')),
    ).resolves.toMatchObject({ status: 'error', error: { code: 'branchInOtherWorktree' } });
    await expect(
      settle(
        mock.createWorktree(id, { path: 'relative', branch: { kind: 'existing', name: 'main' } }),
      ),
    ).resolves.toMatchObject({ status: 'error', error: { code: 'invalidArgument' } });
  });

  it('previews and removes a dirty worktree only when forced', async () => {
    const id = await open();
    const path = `${YAGGUI}-review`;
    const preview = await unwrap(mock.worktreeRemovePreview(id, path));
    expect(preview).toMatchObject({ locked: false, missing: false });
    expect(preview.dirty.unstaged + preview.dirty.untracked).toBeGreaterThan(0);
    expect(preview.branch).not.toBeNull();

    await expect(settle(mock.removeWorktree(id, path, false))).resolves.toMatchObject({
      status: 'error',
      error: { code: 'worktreeDirty' },
    });
    await unwrap(settle(mock.removeWorktree(id, path, true)));
    const refs = await unwrap(mock.listRefs(id));
    expect(refs.worktrees.map((w) => w.path)).not.toContain(path);
    await expect(settle(mock.removeWorktree(id, YAGGUI, true))).resolves.toMatchObject({
      status: 'error',
      error: { code: 'invalidArgument' },
    });
  });

  it('prunes the missing worktrees', async () => {
    const id = await open();
    expect((await unwrap(mock.listRefs(id))).worktrees.some((w) => w.prunable)).toBe(true);
    await unwrap(settle(mock.pruneWorktrees(id)));
    expect((await unwrap(mock.listRefs(id))).worktrees.some((w) => w.prunable)).toBe(false);
  });
});

describe('mock LFS', () => {
  it('reports the patterns, flags LFS files and shows pointers', async () => {
    const id = await open();
    expect(await unwrap(mock.lfsStatus(id))).toMatchObject({
      used: true,
      patterns: ['*.psd', '*.blend'],
    });
    const target = { kind: 'commits', from: null, to: 'HEAD' } as const;
    const files = await unwrap(mock.changedFiles(id, target));
    expect(files.lfs).toEqual(['assets/design/hero.psd']);
    const diff = await unwrap(
      mock.fileDiff(id, target, 'assets/design/hero.psd', null, {
        ignoreWhitespace: false,
        contextLines: 3,
        fullFile: false,
        force: false,
      }),
    );
    expect(diff.content.kind).toBe('lfs');
  });

  it('tracks a pattern, and reports a missing git lfs without blocking reads', async () => {
    const id = await open();
    await unwrap(settle(mock.lfsTrack(id, ' *.zip ')));
    expect((await unwrap(mock.lfsStatus(id))).patterns).toContain('*.zip');
    await expect(settle(mock.lfsTrack(id, '--all'))).resolves.toMatchObject({
      status: 'error',
      error: { code: 'invalidArgument' },
    });

    mockBackend.modules.lfsInstalled = false;
    expect((await unwrap(mock.lfsStatus(id))).version).toBeNull();
    await expect(settle(mock.lfsPull(id))).resolves.toMatchObject({
      status: 'error',
      error: { code: 'lfsNotInstalled' },
    });
  });
});

describe('mock undo of the M4-5 operations', () => {
  it('undoes and redoes a new worktree and its branch', async () => {
    const id = await open();
    const path = `${YAGGUI}-undo`;
    await unwrap(
      settle(
        mock.createWorktree(id, {
          path,
          branch: { kind: 'new', name: 'feat/undo', start: 'main' },
        }),
      ),
    );
    await unwrap(settle(mock.undo(id)));
    let refs = await unwrap(mock.listRefs(id));
    expect(refs.worktrees.map((w) => w.path)).not.toContain(path);
    expect(refs.local.map((b) => b.name)).not.toContain('feat/undo');
    await unwrap(settle(mock.redo(id)));
    refs = await unwrap(mock.listRefs(id));
    expect(refs.worktrees.map((w) => w.path)).toContain(path);
  });

  it('blocks the undo of a forced removal and of network operations', async () => {
    const id = await open();
    await unwrap(settle(mock.removeWorktree(id, `${YAGGUI}-review`, true)));
    let state = await unwrap(mock.undoState(id));
    expect(state.undo?.blocked).toEqual({ kind: 'filesDeleted' });
    await unwrap(settle(mock.lfsPull(id)));
    state = await unwrap(mock.undoState(id));
    expect(state.undo?.blocked).toEqual({ kind: 'downloaded' });
  });

  it('puts the LFS patterns back', async () => {
    const id = await open();
    await unwrap(settle(mock.lfsTrack(id, '*.zip')));
    await unwrap(settle(mock.undo(id)));
    expect((await unwrap(mock.lfsStatus(id))).patterns).not.toContain('*.zip');
    await unwrap(settle(mock.redo(id)));
    expect((await unwrap(mock.lfsStatus(id))).patterns).toContain('*.zip');
  });
});
