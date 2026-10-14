import type {
  InteractiveRebasePlan,
  RebaseAction,
  RebasePlanCommit,
  RebaseTodoEntry,
} from '../../ipc';

/**
 * Pure model of the interactive rebase view (F-142). Rows are kept in todo order, oldest
 * first, as Git and the backend take them; the view shows them reversed (newest on top, like
 * the graph), so "squash into the previous commit" means "into the row below".
 */
export interface RebaseRow {
  commit: RebasePlanCommit;
  action: RebaseAction;
  /**
   * Message typed by the user: the new message of a `reword`; on a `squash`, the message of
   * the combined commit (the last squash of a group that has one wins). `null`: not edited,
   * the default applies (the original message, or the combination of the group's messages).
   */
  message: string | null;
}

export const ACTION_KEYS: Readonly<Record<string, RebaseAction>> = {
  p: 'pick',
  r: 'reword',
  s: 'squash',
  f: 'fixup',
  d: 'drop',
  e: 'edit',
};

export function initialRows(plan: InteractiveRebasePlan): RebaseRow[] {
  return plan.commits.map((commit) => ({ commit, action: 'pick', message: null }));
}

/** Melds into the previous kept commit. */
export function isMelded(action: RebaseAction): boolean {
  return action === 'squash' || action === 'fixup';
}

export function setAction(rows: readonly RebaseRow[], index: number, action: RebaseAction) {
  return rows.map((row, i) => (i === index ? { ...row, action } : row));
}

export function setMessage(rows: readonly RebaseRow[], index: number, message: string | null) {
  return rows.map((row, i) => (i === index ? { ...row, message } : row));
}

/** Moves the row at `from` to index `to` (both in todo order), clamped to the list. */
export function moveRow(rows: readonly RebaseRow[], from: number, to: number): RebaseRow[] {
  const target = Math.max(0, Math.min(rows.length - 1, to));
  const row = rows[from];
  if (!row || target === from) return [...rows];
  const next = rows.filter((_, i) => i !== from);
  next.splice(target, 0, row);
  return next;
}

/** One commit of the result: a kept row and the rows melded into it. */
export interface ResultCommit {
  /** Index (todo order) of the kept row. */
  index: number;
  head: RebaseRow;
  /** Squash and fixup rows melded into it, in todo order, with their indexes. */
  melded: { index: number; row: RebaseRow }[];
  /** Message the commit will have. */
  message: string;
  /** Index of the row whose message is edited for this commit: the reword row, or the last
   * squash of the group; `null` when the message is not editable (pick, edit, fixups only). */
  messageRow: number | null;
  /** Stops after it (`edit`). */
  stops: boolean;
}

export interface RebasePreview {
  /** Oldest first. */
  commits: ResultCommit[];
  /** Dropped rows, by index. */
  dropped: number[];
  /** Squash / fixup rows with no kept commit before them, by index. */
  orphans: number[];
}

/** Summary (first line) of a message. */
export function summaryOf(message: string): string {
  return message.split('\n')[0]?.trim() ?? '';
}

/** Message of the commit of a group by default: the messages of its head and squashes. */
export function combinedMessage(head: RebaseRow, melded: readonly RebaseRow[]): string {
  const headMessage = head.action === 'reword' && head.message !== null ? head.message : null;
  const parts = [headMessage ?? head.commit.message];
  for (const row of melded) if (row.action === 'squash') parts.push(row.commit.message);
  return parts.map((part) => part.trim()).join('\n\n');
}

export function preview(rows: readonly RebaseRow[]): RebasePreview {
  const commits: ResultCommit[] = [];
  const dropped: number[] = [];
  const orphans: number[] = [];
  rows.forEach((row, index) => {
    if (row.action === 'drop') {
      dropped.push(index);
      return;
    }
    const current = commits.at(-1);
    if (isMelded(row.action)) {
      if (current) current.melded.push({ index, row });
      else orphans.push(index);
      return;
    }
    commits.push({
      index,
      head: row,
      melded: [],
      message: '',
      messageRow: row.action === 'reword' ? index : null,
      stops: row.action === 'edit',
    });
  });
  for (const commit of commits) {
    const squashes = commit.melded.filter(({ row }) => row.action === 'squash');
    const edited = squashes.findLast(({ row }) => row.message !== null);
    const lastSquash = squashes.at(-1);
    if (lastSquash) {
      commit.messageRow = lastSquash.index;
      commit.message =
        edited?.row.message ??
        combinedMessage(
          commit.head,
          commit.melded.map(({ row }) => row),
        );
    } else if (commit.head.action === 'reword') {
      commit.message = commit.head.message ?? commit.head.commit.message;
    } else {
      commit.message = commit.head.commit.message;
    }
  }
  return { commits, dropped, orphans };
}

export type RowIssue = 'noTarget' | 'emptyMessage';

export interface Validation {
  /** Problems by row index (todo order). */
  rows: Map<number, RowIssue>;
  /** Every commit would be dropped. */
  allDropped: boolean;
  ok: boolean;
}

export function validate(rows: readonly RebaseRow[]): Validation {
  const result = preview(rows);
  const issues = new Map<number, RowIssue>();
  for (const index of result.orphans) issues.set(index, 'noTarget');
  for (const commit of result.commits) {
    if (commit.messageRow !== null && summaryOf(commit.message) === '') {
      issues.set(commit.messageRow, 'emptyMessage');
    }
  }
  const allDropped = result.commits.length === 0 && rows.length > 0;
  return { rows: issues, allDropped, ok: issues.size === 0 && !allDropped };
}

/** The todo for `interactiveRebase`: messages only where the backend reads them. */
export function toTodo(rows: readonly RebaseRow[]): RebaseTodoEntry[] {
  const messages = new Map<number, string>();
  for (const commit of preview(rows).commits) {
    // A reworded head of a squash group still needs a message (the backend requires one on
    // every `reword`); the squash message it is overridden by is the same text.
    if (commit.head.action === 'reword') messages.set(commit.index, commit.message);
    if (commit.messageRow !== null) messages.set(commit.messageRow, commit.message);
  }
  return rows.map((row, index) => ({
    sha: row.commit.sha,
    action: row.action,
    message: messages.get(index) ?? null,
  }));
}

/** Index of the first row that differs from the plan: everything from there is rewritten. */
export function firstRewritten(rows: readonly RebaseRow[], plan: InteractiveRebasePlan): number {
  const index = rows.findIndex((row, i) => {
    const unchanged = row.commit.sha === plan.commits[i]?.sha && row.action === 'pick';
    return !unchanged;
  });
  return index === -1 ? rows.length : index;
}

/** Nothing would change: every commit picked, in the original order. */
export function isUnchanged(rows: readonly RebaseRow[], plan: InteractiveRebasePlan): boolean {
  return firstRewritten(rows, plan) === rows.length;
}

/** Commits already on the upstream that the rebase rewrites (or drops). */
export function rewrittenPushed(
  rows: readonly RebaseRow[],
  plan: InteractiveRebasePlan,
): RebasePlanCommit[] {
  return plan.commits.slice(firstRewritten(rows, plan)).filter((commit) => commit.pushed);
}
