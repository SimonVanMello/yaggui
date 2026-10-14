import { describe, expect, it } from 'vitest';

import type { DiffOptions, DirtyState } from '../bindings';
import { mockChangedFiles, mockFileDiff } from './diff';
import { textDiff } from './lineDiff';

const CLEAN: DirtyState = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
const HEAD = { kind: 'commits', from: null, to: 'HEAD' } as const;
const OPTIONS: DiffOptions = {
  ignoreWhitespace: false,
  contextLines: 3,
  fullFile: false,
  force: false,
};

const numbered = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${String(i + 1)}\n`).join('');

describe('mock line diff (mirror of git/read/diff/text.rs)', () => {
  it('builds the same hunks as the backend', () => {
    const old = numbered(10);
    const d = textDiff(old, old.replace('line 5\n', 'line five\n'), OPTIONS);
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]).toMatchObject({ id: '-2,7+2,7', kinds: '   -+   ', header: 'line 1' });
    const near = numbered(30).replace('line 2\n', 'two\n').replace('line 8\n', 'eight\n');
    expect(textDiff(near, numbered(30), OPTIONS).hunks[0]?.kinds).toBe(' -+     -+   ');
  });

  it('honors context, whole file, whitespace and line endings', () => {
    const old = numbered(20);
    const now = old.replace('line 10\n', 'ten\n');
    expect(textDiff(old, now, { ...OPTIONS, contextLines: 0 }).hunks[0]?.oldStart).toBe(10);
    expect(textDiff(old, now, { ...OPTIONS, fullFile: true }).hunks[0]?.lines).toHaveLength(21);
    expect(textDiff('a\r\nb\r\n', 'a\nb\n', { ...OPTIONS, ignoreWhitespace: true }).hunks).toEqual(
      [],
    );
    const crlf = textDiff('a\r\nb\r\n', 'a\nb\n', OPTIONS);
    expect([crlf.oldLineEnding, crlf.newLineEnding]).toEqual(['crlf', 'lf']);
    expect(textDiff('a\nb', 'a\nb\n', OPTIONS).oldMissingNewline).toBe(true);
  });
});

describe('mock diff commands', () => {
  it('lists the showcase commit with every kind of change', () => {
    const result = mockChangedFiles('yaggui', CLEAN, HEAD);
    if ('error' in result) throw new Error('unexpected error');
    const byPath = new Map(result.ok.files.map((f) => [f.path, f]));
    expect(byPath.get('src/features/graph/GraphCanvas.tsx')).toMatchObject({
      status: 'renamed',
      oldPath: 'src/graph/Canvas.tsx',
      similarity: 87,
    });
    expect(byPath.get('assets/screenshot.png')).toMatchObject({ binary: true, additions: null });
    expect(byPath.get('scripts/release.sh')).toMatchObject({
      oldMode: 'regular',
      newMode: 'executable',
    });
    expect(byPath.get('vendor/codemirror')?.newMode).toBe('submodule');
  });

  it('applies the size guards unless forced', () => {
    const big = mockFileDiff('yaggui', CLEAN, HEAD, 'fixtures/huge-snapshot.json', null, OPTIONS);
    expect(big).toMatchObject({ ok: { content: { kind: 'tooLarge' } } });
    const forced = mockFileDiff('yaggui', CLEAN, HEAD, 'fixtures/huge-snapshot.json', null, {
      ...OPTIONS,
      force: true,
    });
    expect(forced).toMatchObject({ ok: { content: { kind: 'text' } } });
  });

  it('rejects unknown revisions and paths outside the repository', () => {
    expect(
      mockChangedFiles('yaggui', CLEAN, { kind: 'commits', from: null, to: 'nope' }),
    ).toMatchObject({
      error: { code: 'invalidArgument' },
    });
    expect(mockFileDiff('yaggui', CLEAN, HEAD, '../x', null, OPTIONS)).toMatchObject({
      error: { code: 'invalidArgument' },
    });
  });

  it('sizes the working tree of other repositories by their dirty counts', () => {
    const dirty: DirtyState = { staged: 4, unstaged: 0, untracked: 0, conflicted: 1 };
    const staged = mockChangedFiles('linux', dirty, { kind: 'staged' });
    const unstaged = mockChangedFiles('linux', dirty, { kind: 'unstaged' });
    expect('ok' in staged && staged.ok.files).toHaveLength(4);
    expect('ok' in unstaged && unstaged.ok.files.map((f) => f.status)).toEqual(['conflicted']);
  });
});
