import type { AppInfo, CommandLogEntry, YagguiError, KnownRepo, RepoState } from './bindings';

export const mockAppInfo: AppInfo = {
  appVersion: '0.1.0-mock',
  gitVersion: '2.47.1',
  gitSupported: true,
  minGitVersion: '2.30',
};

/** Fixed "now" (2026-10-12 09:00 UTC) so screenshots and tests are deterministic. */
export const MOCK_NOW = 1_791_795_600;

export interface MockRepo {
  known: KnownRepo;
  state: RepoState;
  /** Set to simulate a repo whose watcher could not start (`watchUnavailable`). */
  watchError?: YagguiError | null;
}

/** Three realistic repos plus a recent one whose folder disappeared. */
export function createMockRepos(): MockRepo[] {
  return [
    {
      known: {
        id: 1,
        path: '/Users/alex/dev/yaggui',
        name: 'yaggui',
        favorite: true,
        lastOpenedAt: MOCK_NOW - 120,
        exists: true,
      },
      state: {
        head: {
          kind: 'branch',
          name: 'feat/graph-lanes',
          oid: '3f9c2a17d0b4e85c6a91f2d7e0c4b3a8f5d61e92',
        },
        upstream: { name: 'origin/feat/graph-lanes', ahead: 2, behind: 0, gone: false },
        dirty: { staged: 2, unstaged: 3, untracked: 1, conflicted: 0 },
        operation: null,
        indexLock: null,
      },
    },
    {
      known: {
        id: 2,
        path: '/Users/alex/dev/linux',
        name: 'linux',
        favorite: false,
        lastOpenedAt: MOCK_NOW - 3_600,
        exists: true,
      },
      state: {
        // During a rebase HEAD is detached on the commit being replayed.
        head: { kind: 'detached', oid: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' },
        upstream: null,
        dirty: { staged: 4, unstaged: 0, untracked: 0, conflicted: 1 },
        operation: {
          kind: 'rebase',
          interactive: true,
          step: 3,
          total: 7,
          headName: 'sched/eevdf-fixes',
        },
        indexLock: null,
      },
    },
    {
      known: {
        id: 3,
        path: '/Users/alex/dev/blog',
        name: 'blog',
        favorite: true,
        lastOpenedAt: MOCK_NOW - 86_400 * 3,
        exists: true,
      },
      state: {
        head: { kind: 'branch', name: 'main', oid: '9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d' },
        upstream: { name: 'origin/main', ahead: 0, behind: 4, gone: false },
        dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
        operation: null,
        indexLock: null,
      },
    },
    {
      known: {
        id: 4,
        path: '/Users/alex/old/legacy-api',
        name: 'legacy-api',
        favorite: false,
        lastOpenedAt: MOCK_NOW - 86_400 * 40,
        exists: false,
      },
      state: {
        head: { kind: 'branch', name: 'master', oid: '0000000000000000000000000000000000000001' },
        upstream: null,
        dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
        operation: null,
        indexLock: null,
      },
    },
  ];
}

function logEntry(
  id: number,
  repoId: number,
  cwd: string,
  args: string[],
  offset: number,
  durationMs: number,
  stdout = '',
  stderr = '',
  exitCode = 0,
): CommandLogEntry {
  return {
    id,
    repoId,
    args,
    cwd,
    startedAt: MOCK_NOW - offset,
    durationMs,
    exitCode,
    status: exitCode === 0 ? 'success' : 'failed',
    stdout,
    stderr,
    truncated: false,
  };
}

export function createMockLog(): CommandLogEntry[] {
  return [
    logEntry(1, 2, '/Users/alex/dev/linux', ['rebase', '-i', 'origin/master'], 900, 412),
    logEntry(
      2,
      2,
      '/Users/alex/dev/linux',
      ['rebase', '--continue'],
      600,
      238,
      '',
      'CONFLICT (content): Merge conflict in kernel/sched/fair.c\nerror: could not apply 4c1e2f0... sched/eevdf: fix lag clamping\n',
      1,
    ),
    logEntry(
      3,
      1,
      '/Users/alex/dev/yaggui',
      ['fetch', '--progress', '--prune', 'origin'],
      300,
      1_284,
      '',
      'From github.com:alexmartin/yaggui\n   7a1c9e2..3f9c2a1  feat/graph-lanes -> origin/feat/graph-lanes\n',
    ),
    logEntry(
      4,
      1,
      '/Users/alex/dev/yaggui',
      ['commit', '-F', '-'],
      180,
      96,
      '[feat/graph-lanes 3f9c2a1] feat(graph): compute lanes incrementally\n 3 files changed, 142 insertions(+), 18 deletions(-)\n',
    ),
  ];
}
