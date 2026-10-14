import { myers, type Edit } from '../diff/myers';

/** Half-open range of line indexes `[start, end)` in one version. */
export interface LineRange {
  start: number;
  end: number;
}

/**
 * A run of the merged file:
 * - `same`: unchanged on both sides;
 * - `ours` / `theirs`: changed on that side only, merged automatically;
 * - `both`: changed identically on both sides;
 * - `conflict`: changed differently on both sides, to resolve.
 */
export interface MergeChunk {
  kind: 'same' | 'ours' | 'theirs' | 'both' | 'conflict';
  base: LineRange;
  ours: LineRange;
  theirs: LineRange;
}

export type Side = 'ours' | 'theirs';

export interface MergeModel {
  /** Lines of each version, each with its own terminator (`\n`, `\r\n`, none at the end). */
  base: string[];
  ours: string[];
  theirs: string[];
  chunks: MergeChunk[];
  /** Indexes in `chunks` of the conflicts, in file order. */
  conflicts: number[];
  /** Line ending of the file, used when a piece without one is followed by another. */
  eol: '\n' | '\r\n';
}

/** Sides kept for a conflict, in the order they were chosen (both: one after the other). */
export type ConflictChoice = readonly Side[];

/** State of one conflict in the result. */
export interface ConflictState {
  choice: ConflictChoice;
  /** Edited by hand since its last choice: resolved whatever the choice. */
  edited: boolean;
}

export const isResolved = (c: ConflictState) => c.edited || c.choice.length > 0;

/** Splits text into lines that keep their terminator, so the result is byte-identical. */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl < 0) break;
    lines.push(text.slice(start, nl + 1));
    start = nl + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** `\r\n` when most terminated lines use it. */
export function detectEol(...texts: string[]): '\n' | '\r\n' {
  let crlf = 0;
  let lf = 0;
  for (const text of texts) {
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
      if (i > 0 && text[i - 1] === '\r') crlf++;
      else lf++;
    }
  }
  return crlf > lf ? '\r\n' : '\n';
}

/** Lines interned as numbers: Myers compares integers instead of strings. */
function intern(table: Map<string, number>, lines: readonly string[]): number[] {
  return lines.map((line) => {
    let id = table.get(line);
    if (id === undefined) {
      id = table.size;
      table.set(line, id);
    }
    return id;
  });
}

interface SideEdit extends Edit {
  side: Side;
}

function sameLines(a: readonly string[], ar: LineRange, b: readonly string[], br: LineRange) {
  if (ar.end - ar.start !== br.end - br.start) return false;
  for (let i = 0; i < ar.end - ar.start; i++) {
    if (a[ar.start + i] !== b[br.start + i]) return false;
  }
  return true;
}

const range = (start: number, end: number): LineRange => ({ start, end });

/**
 * Lines that both sides of a conflict share at its start and end leave it, as Git's
 * "zealous" merge level does: only what really differs stays to resolve.
 */
function trimConflict(model: Pick<MergeModel, 'ours' | 'theirs'>, chunk: MergeChunk): MergeChunk[] {
  const { ours, theirs } = chunk;
  let head = 0;
  const max = Math.min(ours.end - ours.start, theirs.end - theirs.start);
  while (head < max && model.ours[ours.start + head] === model.theirs[theirs.start + head]) head++;
  let tail = 0;
  while (
    tail < max - head &&
    model.ours[ours.end - 1 - tail] === model.theirs[theirs.end - 1 - tail]
  ) {
    tail++;
  }
  if (head === 0 && tail === 0) return [chunk];
  const out: MergeChunk[] = [];
  const b = chunk.base;
  if (head > 0) {
    out.push({
      kind: 'both',
      base: range(b.start, b.start),
      ours: range(ours.start, ours.start + head),
      theirs: range(theirs.start, theirs.start + head),
    });
  }
  out.push({
    kind: 'conflict',
    base: b,
    ours: range(ours.start + head, ours.end - tail),
    theirs: range(theirs.start + head, theirs.end - tail),
  });
  if (tail > 0) {
    out.push({
      kind: 'both',
      base: range(b.end, b.end),
      ours: range(ours.end - tail, ours.end),
      theirs: range(theirs.end - tail, theirs.end),
    });
  }
  return out;
}

/**
 * Three-way merge of whole lines (diff3): changes of each side against the base, grouped
 * when they overlap or touch. A group changed by one side only is merged; changed by both,
 * it is a conflict unless both made the same change. Changes on adjacent lines conflict,
 * as in Git.
 */
export function computeMerge(base: string, ours: string, theirs: string): MergeModel {
  const lines = { base: splitLines(base), ours: splitLines(ours), theirs: splitLines(theirs) };
  const table = new Map<string, number>();
  const ids = {
    base: intern(table, lines.base),
    ours: intern(table, lines.ours),
    theirs: intern(table, lines.theirs),
  };
  const edits: SideEdit[] = [
    ...myers(ids.base, ids.ours).map((e) => ({ ...e, side: 'ours' as const })),
    ...myers(ids.base, ids.theirs).map((e) => ({ ...e, side: 'theirs' as const })),
  ].sort((a, b) => a.aStart - b.aStart || a.aEnd - b.aEnd);

  const model: MergeModel = {
    ...lines,
    chunks: [],
    conflicts: [],
    eol: detectEol(base, ours, theirs),
  };
  // Offset of each side's line numbers against the base, after the edits seen so far.
  const delta = { ours: 0, theirs: 0 };
  let basePos = 0;
  const push = (chunk: MergeChunk) => {
    if (
      chunk.base.end === chunk.base.start &&
      chunk.ours.end === chunk.ours.start &&
      chunk.theirs.end === chunk.theirs.start
    ) {
      return;
    }
    if (chunk.kind === 'conflict') model.conflicts.push(model.chunks.length);
    model.chunks.push(chunk);
  };
  const same = (to: number) => {
    if (to > basePos) {
      push({
        kind: 'same',
        base: range(basePos, to),
        ours: range(basePos + delta.ours, to + delta.ours),
        theirs: range(basePos + delta.theirs, to + delta.theirs),
      });
    }
  };

  let i = 0;
  while (i < edits.length) {
    const first = edits[i];
    if (!first) break;
    const lo = first.aStart;
    let hi = first.aEnd;
    const group: SideEdit[] = [first];
    i++;
    for (let next = edits[i]; next && next.aStart <= hi; next = edits[i]) {
      hi = Math.max(hi, next.aEnd);
      group.push(next);
      i++;
    }
    same(lo);
    const start = { ours: lo + delta.ours, theirs: lo + delta.theirs };
    for (const edit of group)
      delta[edit.side] += edit.bEnd - edit.bStart - (edit.aEnd - edit.aStart);
    const chunk: MergeChunk = {
      kind: 'conflict',
      base: range(lo, hi),
      ours: range(start.ours, hi + delta.ours),
      theirs: range(start.theirs, hi + delta.theirs),
    };
    const sides = new Set(group.map((e) => e.side));
    if (sides.size === 1) {
      chunk.kind = sides.has('ours') ? 'ours' : 'theirs';
      push(chunk);
    } else if (sameLines(lines.ours, chunk.ours, lines.theirs, chunk.theirs)) {
      chunk.kind = 'both';
      push(chunk);
    } else {
      for (const part of trimConflict(lines, chunk)) push(part);
    }
    basePos = hi;
  }
  same(lines.base.length);
  return model;
}

/** Joins pieces of lines, giving a line ending to a piece that ends without one. */
function join(pieces: readonly string[][], eol: string): string {
  let out = '';
  for (const piece of pieces) {
    if (piece.length === 0) continue;
    if (out.length > 0 && !out.endsWith('\n')) out += eol;
    out += piece.join('');
  }
  return out;
}

function slice(lines: readonly string[], r: LineRange): string[] {
  return lines.slice(r.start, r.end);
}

/** Lines a conflict resolves to with `choice` (none chosen: empty). */
export function conflictLines(
  model: MergeModel,
  chunk: MergeChunk,
  choice: ConflictChoice,
): string[] {
  const text = join(
    choice.map((side) => slice(model[side], chunk[side])),
    model.eol,
  );
  return splitLines(text);
}

/** Lines of a non-conflict chunk in the result. */
function mergedLines(model: MergeModel, chunk: MergeChunk): string[] {
  return chunk.kind === 'theirs'
    ? slice(model.theirs, chunk.theirs)
    : slice(model.ours, chunk.ours);
}

/** Where each conflict lies in the result: first line and number of lines. */
export interface ResultRegion {
  line: number;
  count: number;
}

export interface MergeResult {
  text: string;
  /** One per conflict, in the order of `model.conflicts`. */
  regions: ResultRegion[];
}

/**
 * The merged file with the given choice per conflict (missing: unresolved, left empty), and
 * where each conflict landed in it.
 */
export function buildResult(model: MergeModel, choices: readonly ConflictChoice[]): MergeResult {
  const pieces: string[][] = [];
  const regions: ResultRegion[] = [];
  let line = 0;
  let conflict = 0;
  for (const chunk of model.chunks) {
    let piece: string[];
    if (chunk.kind === 'conflict') {
      piece = conflictLines(model, chunk, choices[conflict] ?? []);
      regions.push({ line, count: piece.length });
      conflict++;
    } else {
      piece = mergedLines(model, chunk);
    }
    // A piece without a final line ending only happens at the end of a version; anything
    // after it gets one (`join`), which moves no line index.
    pieces.push(piece);
    line += piece.length;
  }
  return { text: join(pieces, model.eol), regions };
}

/** Toggles `side` in a choice: added after the sides already chosen, or removed. */
export function toggleChoice(choice: ConflictChoice, side: Side): ConflictChoice {
  return choice.includes(side) ? choice.filter((s) => s !== side) : [...choice, side];
}

/** Next (1) or previous (-1) conflict from `current`, wrapping; `null` without conflicts. */
export function adjacentConflict(
  count: number,
  current: number | null,
  direction: 1 | -1,
): number | null {
  if (count === 0) return null;
  if (current === null) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}

/** Text as saved: the editor's `\n` turned back into the file's line ending. */
export function withEol(text: string, eol: '\n' | '\r\n'): string {
  return eol === '\n' ? text : text.replace(/\r?\n/g, '\r\n');
}
