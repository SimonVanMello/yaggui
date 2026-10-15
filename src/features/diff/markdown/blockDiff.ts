import { tokenize, type Range } from '../intraline';
import { myers } from '../myers';
import { parseMarkdown, type MarkdownBlock, type MarkdownDoc } from './markdownDoc';

/** Text removed inside a changed block, shown where it stood in the new version. */
export interface Deletion {
  /** Offset in the new text. */
  at: number;
  text: string;
}

/** Word changes of a block, in offsets of the new text. */
export interface InlineMarks {
  inserted: Range[];
  deleted: Deletion[];
}

export type DiffUnit =
  | { status: 'same'; block: MarkdownBlock }
  | { status: 'added'; block: MarkdownBlock }
  /** `block` is in the old text. */
  | { status: 'removed'; block: MarkdownBlock }
  | { status: 'changed'; block: MarkdownBlock; old: MarkdownBlock; marks: InlineMarks };

export interface MarkdownDiff {
  old: MarkdownDoc;
  new: MarkdownDoc;
  units: DiffUnit[];
}

/** Larger blocks are not compared word by word (a generated table, a pasted log). */
const MAX_BLOCK_LENGTH = 20_000;
/** Above this share of changed characters the block was rewritten: shown removed then added. */
const MAX_CHANGED_RATIO = 0.6;
/** How far ahead an added block is looked for to pair it with a removed one. */
const PAIR_LOOKAHEAD = 4;

function sameKind(a: MarkdownBlock, b: MarkdownBlock): boolean {
  return a.type === b.type && a.list?.kind === b.list?.kind;
}

function offsets(tokens: string[], base: number): number[] {
  const out = [base];
  let total = base;
  for (const token of tokens) {
    total += token.length;
    out.push(total);
  }
  return out;
}

/** Removed Markdown as plain words: the marks around it no longer mean anything. */
export function plainDeletion(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])[ \t]+/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ');
}

/** Word changes from `a` to `b`, or `null` when the two are too different to be one block. */
export function inlineMarks(
  oldText: string,
  a: MarkdownBlock,
  newText: string,
  b: MarkdownBlock,
): InlineMarks | null {
  const before = oldText.slice(a.from, a.to);
  const after = newText.slice(b.from, b.to);
  if (before.length > MAX_BLOCK_LENGTH || after.length > MAX_BLOCK_LENGTH) return null;
  const aTokens = tokenize(before);
  const bTokens = tokenize(after);
  const aAt = offsets(aTokens, a.from);
  const bAt = offsets(bTokens, b.from);
  const marks: InlineMarks = { inserted: [], deleted: [] };
  let changed = 0;
  for (const edit of myers(aTokens, bTokens, 1_000)) {
    const removedFrom = aAt[edit.aStart] ?? a.from;
    const removedTo = aAt[edit.aEnd] ?? a.from;
    const at = bAt[edit.bStart] ?? b.from;
    const insertedTo = bAt[edit.bEnd] ?? b.from;
    changed += removedTo - removedFrom + insertedTo - at;
    if (insertedTo > at) marks.inserted.push({ from: at, to: insertedTo });
    const text = plainDeletion(oldText.slice(removedFrom, removedTo));
    if (text.trim() !== '') marks.deleted.push({ at, text });
  }
  return changed / Math.max(1, before.length + after.length) > MAX_CHANGED_RATIO ? null : marks;
}

/** Pairs the removed and added blocks of one edit: a pair is a block changed in place. */
function pairRun(
  oldDoc: MarkdownDoc,
  removed: MarkdownBlock[],
  newDoc: MarkdownDoc,
  added: MarkdownBlock[],
): DiffUnit[] {
  const units: DiffUnit[] = [];
  let next = 0;
  for (const block of removed) {
    let match: { index: number; marks: InlineMarks } | null = null;
    for (let k = next; k < Math.min(added.length, next + PAIR_LOOKAHEAD); k++) {
      const candidate = added[k];
      if (!candidate || !sameKind(block, candidate)) continue;
      const marks = inlineMarks(oldDoc.text, block, newDoc.text, candidate);
      if (marks) {
        match = { index: k, marks };
        break;
      }
    }
    if (!match) {
      units.push({ status: 'removed', block });
      continue;
    }
    for (; next < match.index; next++) {
      const skipped = added[next];
      if (skipped) units.push({ status: 'added', block: skipped });
    }
    const paired = added[match.index];
    if (paired) units.push({ status: 'changed', block: paired, old: block, marks: match.marks });
    next = match.index + 1;
  }
  for (; next < added.length; next++) {
    const block = added[next];
    if (block) units.push({ status: 'added', block });
  }
  return units;
}

/** The new version of a Markdown document, block by block, with what changed from the old one. */
export function diffMarkdown(oldText: string, newText: string): MarkdownDiff {
  const oldDoc = parseMarkdown(oldText);
  const newDoc = parseMarkdown(newText);
  const a = oldDoc.blocks;
  const b = newDoc.blocks;
  const units: DiffUnit[] = [];
  let j = 0;
  const same = (until: number) => {
    for (; j < until; j++) {
      const block = b[j];
      if (block) units.push({ status: 'same', block });
    }
  };
  for (const edit of myers(
    a.map((block) => block.key),
    b.map((block) => block.key),
  )) {
    same(edit.bStart);
    units.push(
      ...pairRun(oldDoc, a.slice(edit.aStart, edit.aEnd), newDoc, b.slice(edit.bStart, edit.bEnd)),
    );
    j = edit.bEnd;
  }
  same(b.length);
  return { old: oldDoc, new: newDoc, units };
}
