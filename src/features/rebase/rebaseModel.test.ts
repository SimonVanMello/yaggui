import { describe, expect, it } from 'vitest';

import type { InteractiveRebasePlan, RebasePlanCommit } from '../../ipc';
import {
  combinedMessage,
  initialRows,
  isFixupSummary,
  isUnchanged,
  moveRow,
  preview,
  rewrittenPushed,
  rowsFromTodo,
  setAction,
  setMessage,
  toTodo,
  validate,
  type RebaseRow,
} from './rebaseModel';

function commit(n: number, pushed = false): RebasePlanCommit {
  return {
    sha: String(n).repeat(40).slice(0, 40),
    summary: `c${String(n)}`,
    message: `c${String(n)}\n\nbody ${String(n)}`,
    authorName: 'Ada',
    authorEmail: 'ada@yaggui.dev',
    authorTime: 1_700_000_000 + n,
    merge: false,
    pushed,
  };
}

function plan(pushed = 0): InteractiveRebasePlan {
  const commits = [1, 2, 3, 4].map((n) => commit(n, n <= pushed));
  return {
    base: { sha: '0'.repeat(40), summary: 'base' },
    head: commits[3]?.sha ?? '',
    branch: 'main',
    upstream: 'origin/main',
    commits,
    hasMerges: false,
    pushed,
  };
}

const shas = (rows: readonly RebaseRow[]) => rows.map((r) => r.commit.summary);

describe('rebase model', () => {
  it('reorders rows, clamped to the list', () => {
    const rows = initialRows(plan());
    expect(shas(moveRow(rows, 0, 2))).toEqual(['c2', 'c3', 'c1', 'c4']);
    expect(shas(moveRow(rows, 3, 0))).toEqual(['c4', 'c1', 'c2', 'c3']);
    expect(shas(moveRow(rows, 1, -5))).toEqual(['c2', 'c1', 'c3', 'c4']);
    expect(shas(moveRow(rows, 1, 99))).toEqual(['c1', 'c3', 'c4', 'c2']);
    expect(moveRow(rows, 2, 2)).toEqual(rows);
  });

  it('previews kept commits, melded ones and drops', () => {
    let rows = initialRows(plan());
    rows = setAction(rows, 1, 'squash');
    rows = setAction(rows, 2, 'drop');
    rows = setAction(rows, 3, 'fixup');
    const result = preview(rows);
    expect(result.dropped).toEqual([2]);
    expect(result.orphans).toEqual([]);
    expect(result.commits).toHaveLength(1);
    const [only] = result.commits;
    expect(only?.melded.map((m) => m.index)).toEqual([1, 3]);
    // Squash combines the messages; the fixup's is left out.
    expect(only?.message).toBe('c1\n\nbody 1\n\nc2\n\nbody 2');
    expect(only?.messageRow).toBe(1);
  });

  it('uses the edited squash message and the reword message', () => {
    let rows = initialRows(plan());
    rows = setAction(rows, 0, 'reword');
    rows = setMessage(rows, 0, 'New c1\n\n# kept');
    rows = setAction(rows, 1, 'squash');
    expect(preview(rows).commits[0]?.message).toBe('New c1\n\n# kept\n\nc2\n\nbody 2');
    rows = setMessage(rows, 1, 'Combined');
    expect(preview(rows).commits[0]?.message).toBe('Combined');
    rows = setAction(rows, 3, 'reword');
    expect(preview(rows).commits[2]?.message).toBe('c4\n\nbody 4');
    expect(preview(rows).commits[2]?.messageRow).toBe(3);
  });

  it('flags a squash with nothing before, empty messages and all dropped', () => {
    let rows = initialRows(plan());
    rows = setAction(rows, 0, 'drop');
    rows = setAction(rows, 1, 'squash');
    expect(validate(rows).rows.get(1)).toBe('noTarget');
    expect(validate(rows).ok).toBe(false);

    rows = initialRows(plan());
    rows = setAction(rows, 2, 'reword');
    rows = setMessage(rows, 2, '   \nbody');
    expect(validate(rows).rows.get(2)).toBe('emptyMessage');

    rows = initialRows(plan()).map((r) => ({ ...r, action: 'drop' as const }));
    expect(validate(rows)).toMatchObject({ allDropped: true, ok: false });
    expect(validate(initialRows(plan())).ok).toBe(true);
  });

  it('builds the todo with messages where the backend reads them', () => {
    let rows = initialRows(plan());
    rows = moveRow(rows, 3, 0);
    rows = setAction(rows, 1, 'reword');
    rows = setMessage(rows, 1, 'Reworded');
    rows = setAction(rows, 2, 'squash');
    rows = setAction(rows, 3, 'squash');
    const combined = 'Reworded\n\nc2\n\nbody 2\n\nc3\n\nbody 3';
    expect(toTodo(rows)).toEqual([
      { sha: commit(4).sha, action: 'pick', message: null },
      { sha: commit(1).sha, action: 'reword', message: combined },
      { sha: commit(2).sha, action: 'squash', message: null },
      {
        sha: commit(3).sha,
        action: 'squash',
        message: combinedMessage(rows[1] as RebaseRow, [
          rows[2] as RebaseRow,
          rows[3] as RebaseRow,
        ]),
      },
    ]);
    expect(toTodo(rows)[3]?.message).toBe(combined);
  });

  it('counts the pushed commits that are rewritten', () => {
    const p = plan(2);
    let rows = initialRows(p);
    expect(isUnchanged(rows, p)).toBe(true);
    expect(rewrittenPushed(rows, p)).toEqual([]);
    // Changing c3 keeps c1 and c2 as they are.
    rows = setAction(rows, 2, 'drop');
    expect(rewrittenPushed(rows, p)).toEqual([]);
    // Swapping c2 and c3 rewrites c2.
    rows = moveRow(initialRows(p), 1, 2);
    expect(rewrittenPushed(rows, p).map((c) => c.summary)).toEqual(['c2']);
    expect(isUnchanged(rows, p)).toBe(false);
  });

  it('starts from an autosquash todo, falling back to the plan when it does not fit', () => {
    const p = plan();
    const [c1, c2, c3, c4] = p.commits.map((c) => c.sha) as [string, string, string, string];
    const rows = rowsFromTodo(p, [
      { sha: c1, action: 'pick', message: null },
      { sha: c4, action: 'fixup', message: null },
      { sha: c2, action: 'pick', message: null },
      { sha: c3, action: 'pick', message: null },
    ]);
    expect(shas(rows)).toEqual(['c1', 'c4', 'c2', 'c3']);
    expect(rows.map((r) => r.action)).toEqual(['pick', 'fixup', 'pick', 'pick']);
    expect(preview(rows).commits).toHaveLength(3);
    expect(isUnchanged(rows, p)).toBe(false);
    // Missing, unknown or repeated commits: the plan as it is.
    const stale = [{ sha: c1, action: 'pick' as const, message: null }];
    expect(rowsFromTodo(p, stale)).toEqual(initialRows(p));
    expect(rowsFromTodo(p, [...stale, ...stale, ...stale, ...stale])).toEqual(initialRows(p));
  });

  it('recognizes fixup summaries', () => {
    expect(isFixupSummary('fixup! c1')).toBe(true);
    expect(isFixupSummary('fixup!c1')).toBe(false);
    expect(isFixupSummary('squash! c1')).toBe(false);
  });
});
