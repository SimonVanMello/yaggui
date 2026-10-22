import type { LineHistoryEntry } from '../../ipc';

/** 1-based, inclusive, as `git log -L` takes it. */
export interface LineSpan {
  start: number;
  end: number;
}

/** The lines between two 0-based lines of the blame (in either order), 1-based. */
export function spanOf(anchor: number, focus: number): LineSpan {
  return { start: Math.min(anchor, focus) + 1, end: Math.max(anchor, focus) + 1 };
}

/** Whether 0-based `line` is in `span`. */
export function inSpan(span: LineSpan | null, line: number): boolean {
  return span !== null && line + 1 >= span.start && line + 1 <= span.end;
}

/**
 * Where the range is in the commit's version of the file (new side of its hunks), `null` for
 * a merge (no diff) or when the commit removed every line of the range.
 */
export function entrySpan(entry: LineHistoryEntry): LineSpan | null {
  let span: LineSpan | null = null;
  for (const hunk of entry.diff?.hunks ?? []) {
    if (hunk.newLines === 0) continue;
    const end = hunk.newStart + hunk.newLines - 1;
    span = span
      ? { start: Math.min(span.start, hunk.newStart), end: Math.max(span.end, end) }
      : { start: hunk.newStart, end };
  }
  return span;
}
