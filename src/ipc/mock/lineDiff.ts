import { myers } from '../../features/diff/myers';
import type { DiffHunk, DiffOptions, LineEnding, TextDiff } from '../bindings';

/** Same guards as `git/read/diff/text.rs`. */
export const MAX_RENDER_BYTES = 1024 * 1024;
export const MAX_RENDER_LINES = 5_000;

interface Lines {
  raw: string[];
  ending: LineEnding;
  missingNewline: boolean;
}

function splitLines(text: string): Lines {
  const missingNewline = text.length > 0 && !text.endsWith('\n');
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const raw = text.length === 0 ? [] : body.split('\n');
  const terminated = missingNewline ? raw.length - 1 : raw.length;
  const crlf = raw.slice(0, terminated).filter((line) => line.endsWith('\r')).length;
  const ending: LineEnding =
    terminated === 0 ? 'none' : crlf === 0 ? 'lf' : crlf === terminated ? 'crlf' : 'mixed';
  return { raw, ending, missingNewline };
}

const display = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line);

function keys(lines: Lines, ignoreWhitespace: boolean): string[] {
  return lines.raw.map((line, i) => {
    const key = ignoreWhitespace ? line.replace(/\s+/g, '') : line;
    return lines.missingNewline && i === lines.raw.length - 1 ? `${key}\0no-newline` : key;
  });
}

function header(old: Lines, before: number): string {
  for (let i = before - 1; i >= Math.max(0, before - 2000); i--) {
    const line = display(old.raw[i] ?? '');
    if (/^[\p{L}_$]/u.test(line)) return line.slice(0, 80).trimEnd();
  }
  return '';
}

/** Mirror of the backend `text_diff`, so the mock honors the diff options. */
export function textDiff(oldText: string, newText: string, options: DiffOptions): TextDiff {
  const old = splitLines(oldText);
  const now = splitLines(newText);
  const changes = myers(
    keys(old, options.ignoreWhitespace),
    keys(now, options.ignoreWhitespace),
    100_000,
  );
  const context = options.fullFile ? Number.MAX_SAFE_INTEGER : options.contextLines;
  const hunks: DiffHunk[] = [];
  const finish = (oldStart: number, newStart: number, kinds: string, lines: string[]) => {
    const oldLines = kinds.replace(/\+/g, '').length;
    const newLines = kinds.replace(/-/g, '').length;
    const os = oldLines === 0 ? oldStart : oldStart + 1;
    const ns = newLines === 0 ? newStart : newStart + 1;
    hunks.push({
      id: `-${String(os)},${String(oldLines)}+${String(ns)},${String(newLines)}`,
      oldStart: os,
      oldLines,
      newStart: ns,
      newLines,
      header: header(old, oldStart),
      kinds,
      lines,
    });
  };

  let index = 0;
  while (index < changes.length) {
    const first = changes[index];
    if (!first) break;
    const lead = Math.min(first.aStart, context);
    const oldStart = first.aStart - lead;
    const newStart = first.bStart - lead;
    let kinds = '';
    const lines: string[] = [];
    const push = (kind: string, text: string | undefined) => {
      kinds += kind;
      lines.push(display(text ?? ''));
    };
    for (let i = lead; i > 0; i--) push(' ', now.raw[first.bStart - i]);
    for (;;) {
      const change = changes[index];
      if (!change) break;
      for (let i = change.aStart; i < change.aEnd; i++) push('-', old.raw[i]);
      for (let i = change.bStart; i < change.bEnd; i++) push('+', now.raw[i]);
      const next = changes[index + 1];
      index++;
      if (next && next.aStart - change.aEnd <= context * 2) {
        for (let i = 0; i < next.aStart - change.aEnd; i++) push(' ', now.raw[change.bEnd + i]);
        continue;
      }
      const trail = Math.min(old.raw.length - change.aEnd, context);
      for (let i = 0; i < trail; i++) push(' ', now.raw[change.bEnd + i]);
      break;
    }
    finish(oldStart, newStart, kinds, lines);
  }
  if (hunks.length === 0 && options.fullFile && now.raw.length > 0) {
    finish(0, 0, ' '.repeat(now.raw.length), now.raw.map(display));
    const only = hunks[0];
    if (only) only.header = '';
  }

  return {
    hunks,
    additions: changes.reduce((n, c) => n + c.bEnd - c.bStart, 0),
    deletions: changes.reduce((n, c) => n + c.aEnd - c.aStart, 0),
    oldEncoding: 'utf8',
    newEncoding: 'utf8',
    oldLineEnding: old.ending,
    newLineEnding: now.ending,
    oldMissingNewline: old.missingNewline,
    newMissingNewline: now.missingNewline,
    oldLineCount: old.raw.length,
    newLineCount: now.raw.length,
  };
}

export function renderedLines(diff: TextDiff): number {
  return diff.hunks.reduce((n, hunk) => n + hunk.lines.length, 0);
}
