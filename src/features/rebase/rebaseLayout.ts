import { moveRow, type RebaseRow } from './rebaseModel';

/**
 * Screen / todo index mapping and keyboard / pointer helpers of the interactive rebase list.
 * The model keeps rows oldest first; the list shows the newest on top, so the screen index
 * of a row is `count - 1 - todoIndex` (the mapping is its own inverse).
 */
export function flipIndex(index: number, count: number): number {
  return count - 1 - index;
}

export type MoveDirection = 'up' | 'down';

/** Moves the row at todo index `index` one place up or down on screen. */
export function moveOnScreen(
  rows: readonly RebaseRow[],
  index: number,
  direction: MoveDirection,
): { rows: RebaseRow[]; index: number } {
  // Up on screen is towards newer commits: a higher todo index.
  const target = Math.max(0, Math.min(rows.length - 1, index + (direction === 'up' ? 1 : -1)));
  return { rows: moveRow(rows, index, target), index: target };
}

/** Todo index the focus lands on after an arrow key, clamped to the list. */
export function moveFocus(index: number, count: number, direction: MoveDirection): number {
  return Math.max(0, Math.min(count - 1, index + (direction === 'up' ? 1 : -1)));
}

/**
 * Moves the row at todo index `from` to the drop slot `slot`: a gap between screen rows, 0
 * before the first (newest) row and `count` after the last one.
 */
export function moveToSlot(
  rows: readonly RebaseRow[],
  from: number,
  slot: number,
): { rows: RebaseRow[]; index: number } {
  const count = rows.length;
  const source = flipIndex(from, count);
  const clamped = Math.max(0, Math.min(count, slot));
  const screenTarget = clamped > source ? clamped - 1 : clamped;
  const index = flipIndex(screenTarget, count);
  return { rows: moveRow(rows, from, index), index };
}

/** Whether dropping at `slot` leaves the row where it is (the slots right around it). */
export function isNoopSlot(from: number, slot: number, count: number): boolean {
  const source = flipIndex(from, count);
  return slot === source || slot === source + 1;
}

/** Drop slot for a pointer at `y`, given the vertical middle of every screen row, in order. */
export function slotAt(y: number, middles: readonly number[]): number {
  let slot = 0;
  for (const middle of middles) if (y > middle) slot += 1;
  return slot;
}

/** Splits a commit message into the commit box's summary and description. */
export function splitMessage(message: string): { summary: string; description: string } {
  const newline = message.indexOf('\n');
  if (newline === -1) return { summary: message, description: '' };
  const rest = message.slice(newline + 1);
  return {
    summary: message.slice(0, newline),
    description: rest.startsWith('\n') ? rest.slice(1) : rest,
  };
}

/** Message stored in the model: `summary`, blank line, description without trailing blanks. */
export function joinMessage(summary: string, description: string): string {
  const body = description.trimEnd();
  const line = summary.replace(/[\r\n]+/g, ' ');
  return body === '' ? line : `${line}\n\n${body}`;
}

/** Whether `rows` are still the commits of `plan` (a reloaded plan may differ). */
export function rowsMatchPlan(
  rows: readonly RebaseRow[],
  plan: { commits: readonly { sha: string }[] },
): boolean {
  if (rows.length !== plan.commits.length) return false;
  const known = new Set(plan.commits.map((commit) => commit.sha));
  return rows.every((row) => known.has(row.commit.sha));
}
