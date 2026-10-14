import type { ChangedFile, DiffHunk, TextDiff } from '../../ipc';
import { intralineDiff, type Range } from './intraline';

export type LineKind = 'context' | 'add' | 'del' | 'empty';

/** One rendered line, with its numbers on each side (`null` where the side has none). */
export interface DiffLine {
  kind: LineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
  /** Word-level changes inside the line. */
  marks: Range[];
  /** Last line of a side without a final newline. */
  noNewline: boolean;
  /** Index of the hunk the line belongs to. */
  hunk: number;
  /** Index of the line in its hunk's `kinds` / `lines` (`null` for split fillers). */
  hunkLine: number | null;
}

export interface HunkView {
  id: string;
  /** `@@ -a,b +c,d @@ section`. */
  title: string;
  /** Index of the hunk's first line in the rendered lines. */
  firstLine: number;
  hunk: DiffHunk;
}

export interface UnifiedModel {
  lines: DiffLine[];
  hunks: HunkView[];
}

/** Both columns have the same length: missing lines are `empty` fillers. */
export interface SplitModel {
  left: DiffLine[];
  right: DiffLine[];
  hunks: HunkView[];
}

export function hunkTitle(hunk: DiffHunk): string {
  const range = `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`;
  return hunk.header ? `${range} ${hunk.header}` : range;
}

/** A hunk split in runs: unchanged lines, or removed lines followed by the added ones. */
type Block =
  { kind: 'context'; lines: DiffLine[] } | { kind: 'change'; dels: DiffLine[]; adds: DiffLine[] };

function blocks(diff: TextDiff, hunk: DiffHunk, index: number): Block[] {
  const out: Block[] = [];
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  let at = 0;
  const line = (kind: LineKind, text: string, o: number | null, n: number | null): DiffLine => ({
    kind,
    text,
    oldNo: o,
    newNo: n,
    marks: [],
    noNewline:
      (o !== null && o === diff.oldLineCount && diff.oldMissingNewline && kind !== 'add') ||
      (n !== null && n === diff.newLineCount && diff.newMissingNewline && kind !== 'del'),
    hunk: index,
    hunkLine: at,
  });
  for (let i = 0; i < hunk.kinds.length; i++) {
    at = i;
    const kind = hunk.kinds[i];
    const text = hunk.lines[i] ?? '';
    let last = out.at(-1);
    if (kind === '-' || kind === '+') {
      if (last?.kind !== 'change' || (kind === '-' && last.adds.length > 0)) {
        last = { kind: 'change', dels: [], adds: [] };
        out.push(last);
      }
      if (kind === '-') last.dels.push(line('del', text, oldNo++, null));
      else last.adds.push(line('add', text, null, newNo++));
    } else {
      if (last?.kind !== 'context') {
        last = { kind: 'context', lines: [] };
        out.push(last);
      }
      last.lines.push(line('context', text, oldNo++, newNo++));
    }
  }
  // Removed and added lines are paired in order for word-level highlights.
  for (const block of out) {
    if (block.kind !== 'change') continue;
    const pairs = Math.min(block.dels.length, block.adds.length);
    for (let i = 0; i < pairs; i++) {
      const del = block.dels[i];
      const add = block.adds[i];
      if (!del || !add) continue;
      const ranges = intralineDiff(del.text, add.text);
      if (ranges) {
        del.marks = ranges.old;
        add.marks = ranges.new;
      }
    }
  }
  return out;
}

export function unifiedModel(diff: TextDiff): UnifiedModel {
  const lines: DiffLine[] = [];
  const hunks: HunkView[] = [];
  diff.hunks.forEach((hunk, index) => {
    hunks.push({ id: hunk.id, title: hunkTitle(hunk), firstLine: lines.length, hunk });
    for (const block of blocks(diff, hunk, index)) {
      if (block.kind === 'context') lines.push(...block.lines);
      else lines.push(...block.dels, ...block.adds);
    }
  });
  return { lines, hunks };
}

function filler(index: number): DiffLine {
  return {
    kind: 'empty',
    text: '',
    oldNo: null,
    newNo: null,
    marks: [],
    noNewline: false,
    hunk: index,
    hunkLine: null,
  };
}

export function splitModel(diff: TextDiff): SplitModel {
  const left: DiffLine[] = [];
  const right: DiffLine[] = [];
  const hunks: HunkView[] = [];
  diff.hunks.forEach((hunk, index) => {
    hunks.push({ id: hunk.id, title: hunkTitle(hunk), firstLine: left.length, hunk });
    for (const block of blocks(diff, hunk, index)) {
      if (block.kind === 'context') {
        left.push(...block.lines);
        right.push(...block.lines);
        continue;
      }
      const rows = Math.max(block.dels.length, block.adds.length);
      for (let i = 0; i < rows; i++) {
        left.push(block.dels[i] ?? filler(index));
        right.push(block.adds[i] ?? filler(index));
      }
    }
  });
  return { left, right, hunks };
}

/** Lines starting a run of changes: `n`/`p` stop on each, not only on hunk headers. */
export function changeStarts(lines: DiffLine[]): number[] {
  const out: number[] = [];
  lines.forEach((line, i) => {
    const changed = line.kind !== 'context';
    const prev = lines[i - 1];
    const prevChanged = prev ? prev.kind !== 'context' && prev.hunk === line.hunk : false;
    if (changed && !prevChanged) out.push(i);
  });
  return out;
}

/**
 * Next (`direction` 1) or previous (-1) stop after/before `current` (a line index), or `null`
 * at the end. With no current position, `n` goes to the first stop.
 */
export function adjacentStop(
  stops: number[],
  current: number | null,
  direction: 1 | -1,
): number | null {
  if (stops.length === 0) return null;
  if (current === null) return direction === 1 ? (stops[0] ?? null) : null;
  if (direction === 1) return stops.find((stop) => stop > current) ?? null;
  for (let i = stops.length - 1; i >= 0; i--) {
    const stop = stops[i];
    if (stop !== undefined && stop < current) return stop;
  }
  return null;
}

/** File after/before `path` in the list, `null` at the ends (no wrap: the end is visible). */
export function adjacentFile(
  files: readonly ChangedFile[],
  path: string,
  direction: 1 | -1,
): ChangedFile | null {
  const index = files.findIndex((file) => file.path === path);
  if (index < 0) return files[0] ?? null;
  return files[index + direction] ?? null;
}
