import { myers } from './myers';

/** Character range `[from, to)` changed inside a line. */
export interface Range {
  from: number;
  to: number;
}

export interface IntralineRanges {
  old: Range[];
  new: Range[];
}

/** Longer lines are not compared word by word (minified code, data). */
const MAX_LINE_LENGTH = 1_000;
/** Above this share of changed characters, word highlights are noise: the line is just new. */
const MAX_CHANGED_RATIO = 0.6;

/** Words, runs of whitespace, and single punctuation characters. */
export function tokenize(line: string): string[] {
  return line.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];
}

function offsets(tokens: string[]): number[] {
  const out = [0];
  let total = 0;
  for (const token of tokens) {
    total += token.length;
    out.push(total);
  }
  return out;
}

function merge(ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const range of ranges) {
    const last = out.at(-1);
    if (last && last.to >= range.from) last.to = Math.max(last.to, range.to);
    else if (range.to > range.from) out.push({ ...range });
  }
  return out;
}

function changed(ranges: Range[]): number {
  return ranges.reduce((sum, r) => sum + r.to - r.from, 0);
}

/**
 * Word-level changes between a removed line and the added line paired with it, or `null`
 * when the lines are too long or too different for highlights to help.
 */
export function intralineDiff(oldLine: string, newLine: string): IntralineRanges | null {
  if (oldLine.length > MAX_LINE_LENGTH || newLine.length > MAX_LINE_LENGTH) return null;
  if (oldLine === newLine) return { old: [], new: [] };
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  const aAt = offsets(a);
  const bAt = offsets(b);
  const edits = myers(a, b, 200);
  const result: IntralineRanges = {
    old: merge(edits.map((e) => ({ from: aAt[e.aStart] ?? 0, to: aAt[e.aEnd] ?? 0 }))),
    new: merge(edits.map((e) => ({ from: bAt[e.bStart] ?? 0, to: bAt[e.bEnd] ?? 0 }))),
  };
  const ratio =
    (changed(result.old) + changed(result.new)) / Math.max(1, oldLine.length + newLine.length);
  return ratio > MAX_CHANGED_RATIO ? null : result;
}
