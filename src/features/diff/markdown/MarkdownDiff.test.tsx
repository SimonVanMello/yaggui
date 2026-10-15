import { render } from '@testing-library/react';
import { Tooltip } from 'radix-ui';
import { describe, expect, it } from 'vitest';

import { MarkdownDiff } from './MarkdownDiff';

function rendered(oldText: string, newText: string): HTMLElement {
  const { container } = render(
    <Tooltip.Provider>
      <MarkdownDiff oldText={oldText} newText={newText} />
    </Tooltip.Provider>,
  );
  const article = container.querySelector('article');
  if (!article) throw new Error('no document');
  return article;
}

describe('MarkdownDiff', () => {
  it('renders the document with the inserted and removed words in place', () => {
    const doc = rendered(
      '# Title\n\nThe **quick** brown fox.\n',
      '# Title\n\nThe **quick** red fox.\n',
    );
    expect(doc.querySelector('h1')?.textContent).toBe('Title');
    const paragraph = doc.querySelector('[data-status="changed"] p');
    expect(paragraph?.querySelector('strong')?.textContent).toBe('quick');
    expect(paragraph?.querySelector('ins')?.textContent).toBe('red');
    expect(paragraph?.querySelector('del')?.textContent).toBe('brown');
    expect(paragraph?.textContent).toBe('The quick brownred fox.');
  });

  it('keeps list items in one list, numbered as written', () => {
    const doc = rendered('1. a\n2. b\n3. c\n', '1. a\n3. c\n4. d\n');
    const lists = doc.querySelectorAll('ol');
    expect(lists).toHaveLength(1);
    const items = [...doc.querySelectorAll('ol > li')];
    expect(items.map((item) => item.getAttribute('data-status'))).toEqual([
      'same',
      'removed',
      'same',
      'added',
    ]);
    expect(items.map((item) => item.getAttribute('value'))).toEqual(['1', '2', '3', '4']);
  });

  it('shows raw HTML as text and never makes a navigating link', () => {
    const doc = rendered(
      '',
      'Click [here](https://example.com) <img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n',
    );
    expect(doc.querySelector('img, script, a')).toBeNull();
    expect(doc.textContent).toContain('<script>alert(1)</script>');
    expect(doc.querySelector('[title="https://example.com"]')?.textContent).toBe('here');
  });

  it('renders tables, tasks and code blocks', () => {
    const doc = rendered(
      '',
      '| a | b |\n|:--|--:|\n| 1 | `2` |\n\n- [x] done\n- [ ] todo\n\n```ts\nconst x = 1;\n```\n',
    );
    expect([...doc.querySelectorAll('th')].map((cell) => cell.style.textAlign)).toEqual([
      'left',
      'right',
    ]);
    expect(doc.querySelector('td code')?.textContent).toBe('2');
    const boxes = [...doc.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    expect(doc.querySelector('pre code')?.textContent).toBe('const x = 1;');
  });

  it('numbers the changes for the navigation', () => {
    const doc = rendered('A.\n\nB.\n\nC.\n\nD.\n', 'A.\n\nB2 new.\n\nC.\n\nE.\n');
    expect(doc.querySelectorAll('[data-change]')).toHaveLength(2);
  });
});
