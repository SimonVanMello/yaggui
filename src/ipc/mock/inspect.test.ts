import { beforeEach, describe, expect, it } from 'vitest';

import type {
  FileHistoryCursor,
  FileHistoryEntry,
  FileHistoryPage,
  LineHistoryCursor,
  LineHistoryEntry,
  LineHistoryPage,
} from '../bindings';
import { mockBackend, mockClient } from '../mockClient';
import { unwrap } from '../result';
import { MOCK_HUGE_FILE_LINES } from './inspect';

const { commands: mock } = mockClient;

beforeEach(() => {
  mockBackend.reset();
});

async function yaggui() {
  return (await unwrap(mock.openRepo('/Users/alex/dev/yaggui'))).id;
}

/** The mock answers like the real backend (`src-tauri/tests/inspect.rs`). */
describe('mock file history, blame and reflog', () => {
  it('pages a file history that follows a rename', async () => {
    const id = await yaggui();
    const all = await unwrap(mock.fileHistory(id, 'src/app/Thing.ts', null, null, 500, 1));
    expect(all.next).toBeNull();
    const renamed = all.entries.findIndex((e) => e.status === 'renamed');
    expect(renamed).toBeGreaterThan(0);
    expect(all.entries[renamed]?.oldPath).toBe('legacy/Thing.ts');
    expect(all.entries[renamed + 1]?.path).toBe('legacy/Thing.ts');
    expect(all.entries.at(-1)?.status).toBe('added');

    const paged: FileHistoryEntry[] = [];
    let cursor: FileHistoryCursor | null = null;
    do {
      const page: FileHistoryPage = await unwrap(
        mock.fileHistory(id, 'src/app/Thing.ts', null, cursor, 3, 1),
      );
      paged.push(...page.entries);
      cursor = page.next;
    } while (cursor);
    expect(paged).toEqual(all.entries);

    const bad = await mock.fileHistory(id, '../x', null, null, 10, 1);
    expect(bad).toMatchObject({ status: 'error', error: { code: 'invalidArgument' } });
    const rev = await mock.fileHistory(id, 'a.ts', 'nope', null, 10, 1);
    expect(rev).toMatchObject({ status: 'error', error: { code: 'revisionNotFound' } });
  });

  it('gives the diff of each history commit', async () => {
    const id = await yaggui();
    const { entries } = await unwrap(mock.fileHistory(id, 'src/app/Thing.ts', null, null, 500, 1));
    const entry = entries.find((e) => e.status === 'renamed');
    if (!entry) throw new Error('no rename');
    const diff = await unwrap(
      mock.fileDiff(id, { kind: 'commits', from: null, to: entry.sha }, entry.path, entry.oldPath, {
        ignoreWhitespace: false,
        contextLines: 3,
        fullFile: false,
        force: false,
      }),
    );
    expect(diff.content.kind).toBe('text');
  });

  it('pages the history of a line range, oldest entry adding the lines', async () => {
    const id = await yaggui();
    const request = { path: 'src/app/Thing.ts', rev: null, start: 10, end: 14 };
    const all = await unwrap(mock.lineHistory(id, request, null, 500, 1));
    expect(all.range).toMatchObject({ path: 'src/app/Thing.ts', start: 10, end: 14 });
    expect(all.entries.length).toBeGreaterThan(1);
    const last = all.entries.at(-1);
    expect(last?.origin).toBe(true);
    expect(last?.diff?.hunks[0]?.kinds).toBe('+++++');
    // The range moves with the lines added or removed above it: each commit starts where the
    // newer one ended.
    let expected = 10;
    for (const entry of all.entries.slice(0, -1)) {
      if (entry.diff === null) continue;
      expect(entry.diff.hunks[0]?.newStart).toBe(expected);
      expect(entry.diff.additions).toBeGreaterThan(0);
      expected = entry.diff.hunks[0]?.oldStart ?? expected;
    }

    const paged: LineHistoryEntry[] = [];
    let cursor: LineHistoryCursor | null = null;
    do {
      const page: LineHistoryPage = await unwrap(mock.lineHistory(id, request, cursor, 2, 1));
      expect(page.entries.length).toBeLessThanOrEqual(2);
      paged.push(...page.entries);
      cursor = page.next;
    } while (cursor);
    expect(paged).toEqual(all.entries);
  });

  it('refuses invalid line ranges like the backend', async () => {
    const id = await yaggui();
    const code = async (start: number, end: number, path = 'src/app/Thing.ts') => {
      const result = await mock.lineHistory(id, { path, rev: null, start, end }, null, 500, 1);
      return result.status === 'error' ? result.error.code : null;
    };
    expect(await code(0, 2)).toBe('invalidArgument');
    expect(await code(5, 4)).toBe('invalidArgument');
    expect(await code(1, 6_000)).toBe('invalidArgument');
    expect(await code(1, 4_000)).toBe('invalidArgument');
    expect(await code(1, 1, 'assets/logo.png')).toBe('invalidArgument');
    expect(await code(1, 1)).toBeNull();
  });

  it('blames every line once, binaries and new files apart', async () => {
    const id = await yaggui();
    const blame = await unwrap(mock.blame(id, { path: 'src/app/Thing.ts', rev: 'HEAD' }, 1));
    if (blame.content.kind !== 'text') throw new Error(blame.content.kind);
    const { lines, chunks, commits } = blame.content;
    expect(chunks.reduce((sum, c) => sum + c.count, 0)).toBe(lines.length);
    expect(chunks.every((c) => c.commit < commits.length)).toBe(true);
    expect(blame.rev).toMatch(/^[0-9a-f]{40}$/);

    const huge = await unwrap(mock.blame(id, { path: 'fixtures/huge.json', rev: null }, 1));
    expect(huge.content.kind === 'text' && huge.content.lines.length).toBe(MOCK_HUGE_FILE_LINES);
    expect((await unwrap(mock.blame(id, { path: 'a/logo.png', rev: null }, 1))).content.kind).toBe(
      'binary',
    );
    // `notes/todo.md` is untracked in the yaggui fixture.
    expect((await unwrap(mock.blame(id, { path: 'notes/todo.md', rev: null }, 1))).content).toEqual(
      { kind: 'notCommitted' },
    );
    // `README.md` has unstaged changes: some lines are not committed.
    const dirty = await unwrap(mock.blame(id, { path: 'README.md', rev: null }, 1));
    expect(dirty.content.kind === 'text' && dirty.content.commits.some((c) => c.uncommitted)).toBe(
      true,
    );
  });

  it('reads the reflog of HEAD and of branches', async () => {
    const id = await yaggui();
    const head = await unwrap(mock.reflog(id, 'HEAD', 0, 500));
    expect(head.entries[0]?.index).toBe(0);
    expect(head.total).toBe(head.entries.length);
    expect(head.entries.some((e) => !e.exists)).toBe(true);
    const page = await unwrap(mock.reflog(id, 'HEAD', 2, 2));
    expect(page.entries.map((e) => e.index)).toEqual([2, 3]);
    expect(page.entries[0]).toEqual({ ...head.entries[2], index: 2 });

    const main = await unwrap(mock.reflog(id, 'refs/heads/main', 0, 500));
    expect(main.entries.at(-1)?.message).toBe('branch: Created from HEAD');
    expect(await mock.reflog(id, 'main', 0, 10)).toMatchObject({
      status: 'error',
      error: { code: 'invalidArgument' },
    });
    expect(await mock.reflog(id, 'refs/heads/nope', 0, 10)).toMatchObject({
      status: 'error',
      error: { code: 'revisionNotFound' },
    });
  });
});
