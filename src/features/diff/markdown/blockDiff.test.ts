import { describe, expect, it } from 'vitest';

import type { TextDiff } from '../../../ipc';
import { diffMarkdown, plainDeletion } from './blockDiff';
import { parseMarkdown } from './markdownDoc';
import { textSides } from './textSides';

const statuses = (oldText: string, newText: string) =>
  diffMarkdown(oldText, newText).units.map((unit) => `${unit.status}:${unit.block.type}`);

describe('parseMarkdown', () => {
  it('splits top-level lists into items and keeps the front matter apart', () => {
    const doc = parseMarkdown('---\ntitle: x\n---\n# Title\n\n- a\n- b\n\n1. c\n');
    expect(doc.blocks.map((block) => block.type)).toEqual([
      'FrontMatter',
      'ATXHeading1',
      'ListItem',
      'ListItem',
      'ListItem',
    ]);
    expect(doc.blocks.map((block) => block.list?.kind ?? null)).toEqual([
      null,
      null,
      'bullet',
      'bullet',
      'ordered',
    ]);
  });

  it('tells tight lists from loose ones', () => {
    expect(parseMarkdown('- a\n- b\n').blocks[0]?.list?.tight).toBe(true);
    expect(parseMarkdown('- a\n\n- b\n').blocks[0]?.list?.tight).toBe(false);
  });
});

describe('diffMarkdown', () => {
  it('finds nothing between equal documents', () => {
    const text = '# A\n\nSome text.\n\n- one\n- two\n';
    expect(statuses(text, text)).toEqual([
      'same:ATXHeading1',
      'same:Paragraph',
      'same:ListItem',
      'same:ListItem',
    ]);
  });

  it('marks the words changed inside a paragraph', () => {
    const oldText = 'The quick brown fox jumps.\n';
    const newText = 'The quick red fox jumps high.\n';
    const [unit] = diffMarkdown(oldText, newText).units;
    expect(unit?.status).toBe('changed');
    if (unit?.status !== 'changed') return;
    expect(unit.marks.inserted.map((range) => newText.slice(range.from, range.to))).toEqual([
      'red',
      ' high',
    ]);
    expect(unit.marks.deleted).toEqual([{ at: 10, text: 'brown' }]);
  });

  it('shows a rewritten block as removed then added', () => {
    expect(statuses('Hello world.\n', 'Completely different sentence here.\n')).toEqual([
      'removed:Paragraph',
      'added:Paragraph',
    ]);
  });

  it('adds and removes whole blocks around unchanged ones', () => {
    expect(statuses('# A\n\nKept.\n\nGone.\n', '# A\n\nNew one.\n\nKept.\n')).toEqual([
      'same:ATXHeading1',
      'added:Paragraph',
      'same:Paragraph',
      'removed:Paragraph',
    ]);
  });

  it('marks only the list item that changed, and not a renumbering', () => {
    expect(statuses('1. a\n2. b\n3. c\n', '1. a\n2. c\n')).toEqual([
      'same:ListItem',
      'removed:ListItem',
      'same:ListItem',
    ]);
    expect(statuses('- alpha beta\n- gamma\n', '- alpha beta delta\n- gamma\n')).toEqual([
      'changed:ListItem',
      'same:ListItem',
    ]);
  });

  it('never pairs blocks of different kinds', () => {
    expect(statuses('Intro text here\n', '# Intro text here\n')).toEqual([
      'removed:Paragraph',
      'added:ATXHeading1',
    ]);
  });
});

describe('plainDeletion', () => {
  it('drops the Markdown marks of removed text', () => {
    expect(plainDeletion('**bold** and [a link](http://x)\n> quote')).toBe('bold and a link quote');
  });
});

describe('textSides', () => {
  it('rebuilds both versions from a whole-file diff', () => {
    const diff: TextDiff = {
      additions: 1,
      deletions: 1,
      oldEncoding: 'utf8',
      newEncoding: 'utf8',
      oldLineEnding: 'lf',
      newLineEnding: 'lf',
      oldMissingNewline: false,
      newMissingNewline: false,
      oldLineCount: 3,
      newLineCount: 3,
      hunks: [
        {
          id: '-1,3+1,3',
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          header: '',
          kinds: ' -+ ',
          lines: ['# A', 'old', 'new', 'end'],
        },
      ],
    };
    expect(textSides(diff)).toEqual({ old: '# A\nold\nend', new: '# A\nnew\nend' });
  });
});
