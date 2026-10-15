import type { ReactNode } from 'react';

import { Icon } from '../../../ui/Icon';
import type { Deletion, InlineMarks } from './blockDiff';
import { isTight, type MarkdownBlock, type SyntaxNode } from './markdownDoc';
import styles from './MarkdownDiff.module.css';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  rarr: '→',
  larr: '←',
  times: '×',
  middot: '·',
  bull: '•',
};

export function decodeEntity(entity: string): string {
  const body = entity.slice(1, -1);
  const code =
    body.startsWith('#x') || body.startsWith('#X')
      ? Number.parseInt(body.slice(2), 16)
      : body.startsWith('#')
        ? Number.parseInt(body.slice(1), 10)
        : Number.NaN;
  if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
  return ENTITIES[body] ?? entity;
}

/** Marks that render nothing: the structure they delimit is rendered instead. */
const HIDDEN = new Set([
  'HeaderMark',
  'QuoteMark',
  'ListMark',
  'EmphasisMark',
  'StrikethroughMark',
  'CodeMark',
  'CodeInfo',
  'LinkMark',
  'URL',
  'LinkTitle',
  'LinkLabel',
  'TaskMarker',
  'TableDelimiter',
]);

type Align = 'left' | 'center' | 'right' | undefined;

/**
 * Renders a block of a Markdown syntax tree to React elements. Never through HTML: raw HTML
 * in the document is shown as code, and links do not navigate (the window is the app).
 */
class Renderer {
  private key = 0;
  private readonly emitted = new Set<Deletion>();

  constructor(
    private readonly text: string,
    private readonly marks: InlineMarks | null,
  ) {}

  private next(): number {
    return this.key++;
  }

  private deletion(deletion: Deletion): ReactNode {
    this.emitted.add(deletion);
    return (
      <del key={this.next()} className={styles.deleted}>
        {deletion.text}
      </del>
    );
  }

  /** Source text `[from, to)`, with the inserted words and the removed ones that stood there. */
  textRange(from: number, to: number, closing = false): ReactNode[] {
    if (!this.marks) return to > from ? [this.text.slice(from, to)] : [];
    const { inserted, deleted } = this.marks;
    const cuts = new Set([from, to]);
    for (const range of inserted) {
      if (range.from > from && range.from < to) cuts.add(range.from);
      if (range.to > from && range.to < to) cuts.add(range.to);
    }
    for (const deletion of deleted) {
      if (deletion.at > from && deletion.at < to) cuts.add(deletion.at);
    }
    const points = [...cuts].sort((x, y) => x - y);
    const out: ReactNode[] = [];
    const flush = (at: number) => {
      for (const deletion of deleted) {
        if (deletion.at === at && !this.emitted.has(deletion)) out.push(this.deletion(deletion));
      }
    };
    for (let i = 0; i + 1 < points.length; i++) {
      const start = points[i] ?? from;
      const end = points[i + 1] ?? to;
      flush(start);
      const slice = this.text.slice(start, end);
      const isInserted = inserted.some((range) => range.from <= start && range.to >= end);
      out.push(
        isInserted ? (
          <ins key={this.next()} className={styles.inserted}>
            {slice}
          </ins>
        ) : (
          slice
        ),
      );
    }
    if (closing) flush(to);
    return out;
  }

  /** Removed words whose place held no text (in a link target, between two marks…). */
  leftovers(): ReactNode[] {
    return (this.marks?.deleted ?? [])
      .filter((deletion) => !this.emitted.has(deletion))
      .map((deletion) => this.deletion(deletion));
  }

  inline(node: SyntaxNode, from = node.from, to = node.to): ReactNode[] {
    const out: ReactNode[] = [];
    let pos = from;
    for (let child = node.firstChild; child && child.from < to; child = child.nextSibling) {
      if (child.to <= from) continue;
      if (child.from > pos) out.push(...this.textRange(pos, child.from));
      out.push(this.inlineNode(child));
      pos = Math.max(pos, child.to);
    }
    if (to > pos || this.marks) out.push(...this.textRange(pos, Math.max(pos, to), true));
    return out;
  }

  /** End of a link or image label: the `]` mark. */
  private labelEnd(node: SyntaxNode): number {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === 'LinkMark' && this.text.slice(child.from, child.to) === ']') {
        return child.from;
      }
    }
    return node.to;
  }

  private target(node: SyntaxNode): string | undefined {
    const url = node.getChild('URL');
    return url ? this.text.slice(url.from, url.to) : undefined;
  }

  private inlineNode(node: SyntaxNode): ReactNode {
    const key = this.next();
    const name = node.name;
    if (HIDDEN.has(name)) return null;
    switch (name) {
      case 'Emphasis':
        return <em key={key}>{this.inline(node)}</em>;
      case 'StrongEmphasis':
        return <strong key={key}>{this.inline(node)}</strong>;
      case 'Strikethrough':
        return <s key={key}>{this.inline(node)}</s>;
      case 'InlineCode':
        return (
          <code key={key} className={styles.code}>
            {this.inline(node)}
          </code>
        );
      case 'Link': {
        const label = this.labelEnd(node);
        return (
          <span key={key} className={styles.link} title={this.target(node)}>
            {this.inline(node, node.from, label)}
          </span>
        );
      }
      case 'Autolink': {
        const url = node.getChild('URL');
        return (
          <span key={key} className={styles.link}>
            {url ? this.textRange(url.from, url.to) : this.text.slice(node.from, node.to)}
          </span>
        );
      }
      case 'Image': {
        const src = this.target(node);
        return (
          <span key={key} className={styles.image} title={src}>
            <Icon name="image" />
            {this.inline(node, node.from, this.labelEnd(node))}
          </span>
        );
      }
      case 'Entity':
        return decodeEntity(this.text.slice(node.from, node.to));
      case 'Escape':
        return this.text.slice(node.from + 1, node.to);
      case 'HardBreak':
        return <br key={key} />;
      case 'HTMLTag':
      case 'Comment':
      case 'ProcessingInstruction':
        return (
          <code key={key} className={styles.html}>
            {this.text.slice(node.from, node.to)}
          </code>
        );
      default:
        return this.inline(node);
    }
  }

  private codeText(node: SyntaxNode): ReactNode[] {
    const out: ReactNode[] = [];
    for (const part of node.getChildren('CodeText'))
      out.push(...this.textRange(part.from, part.to));
    return out;
  }

  private alignments(table: SyntaxNode): Align[] {
    const delimiter = table.getChild('TableDelimiter');
    if (!delimiter) return [];
    return this.text
      .slice(delimiter.from, delimiter.to)
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((cell) => {
        const spec = cell.trim();
        if (spec.startsWith(':') && spec.endsWith(':')) return 'center';
        if (spec.endsWith(':')) return 'right';
        if (spec.startsWith(':')) return 'left';
        return undefined;
      });
  }

  private row(row: SyntaxNode, header: boolean, align: Align[]): ReactNode {
    const cells = row.getChildren('TableCell');
    return (
      <tr key={this.next()}>
        {cells.map((cell, index) =>
          header ? (
            <th key={this.next()} style={{ textAlign: align[index] }}>
              {this.inline(cell)}
            </th>
          ) : (
            <td key={this.next()} style={{ textAlign: align[index] }}>
              {this.inline(cell)}
            </td>
          ),
        )}
      </tr>
    );
  }

  /** The content of a list item, its paragraphs inline when the list is tight. */
  itemContent(item: SyntaxNode, tight: boolean): ReactNode[] {
    const out: ReactNode[] = [];
    for (let child = item.firstChild; child; child = child.nextSibling) {
      if (child.name === 'ListMark') continue;
      if (child.name === 'Task') {
        const marker = child.getChild('TaskMarker');
        const done = marker ? /x/i.test(this.text.slice(marker.from, marker.to)) : false;
        out.push(
          <span key={this.next()} className={styles.task}>
            <input type="checkbox" checked={done} disabled readOnly className={styles.checkbox} />
            <span>{this.inline(child, marker?.to ?? child.from)}</span>
          </span>,
        );
      } else if (tight && child.name === 'Paragraph') {
        out.push(...this.inline(child));
      } else {
        out.push(this.block(child));
      }
    }
    return out;
  }

  /** `value` of an ordered list item: its own number, so that removed items do not shift others. */
  itemNumber(item: SyntaxNode): number | undefined {
    const mark = item.getChild('ListMark');
    if (!mark) return undefined;
    const value = Number.parseInt(this.text.slice(mark.from, mark.to), 10);
    return Number.isFinite(value) ? value : undefined;
  }

  private list(node: SyntaxNode): ReactNode {
    const tight = isTight(node, this.text);
    const items = node.getChildren('ListItem').map((item) => (
      <li key={this.next()} value={node.name === 'OrderedList' ? this.itemNumber(item) : undefined}>
        {this.itemContent(item, tight)}
      </li>
    ));
    return node.name === 'OrderedList' ? (
      <ol key={this.next()}>{items}</ol>
    ) : (
      <ul key={this.next()}>{items}</ul>
    );
  }

  /** The title of a heading, without its `#` marks (opening, closing) or Setext underline. */
  private headingText(node: SyntaxNode): [number, number] {
    let from = node.from;
    let to = node.to;
    const first = node.firstChild;
    const last = node.lastChild;
    if (first?.name === 'HeaderMark' && first.from === node.from) from = first.to;
    if (last?.name === 'HeaderMark' && last.from > from) to = last.from;
    while (from < to && /\s/.test(this.text.charAt(from))) from++;
    while (to > from && /\s/.test(this.text.charAt(to - 1))) to--;
    return [from, to];
  }

  block(node: SyntaxNode): ReactNode {
    const key = this.next();
    const name = node.name;
    const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
    if (heading) {
      const Tag = `h${heading[1] ?? '1'}` as 'h1';
      const [from, to] = this.headingText(node);
      return <Tag key={key}>{this.inline(node, from, to)}</Tag>;
    }
    switch (name) {
      case 'Paragraph':
        return <p key={key}>{this.inline(node)}</p>;
      case 'Blockquote': {
        const children: ReactNode[] = [];
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.name !== 'QuoteMark') children.push(this.block(child));
        }
        return <blockquote key={key}>{children}</blockquote>;
      }
      case 'BulletList':
      case 'OrderedList':
        return this.list(node);
      case 'FencedCode':
      case 'CodeBlock': {
        const info = node.getChild('CodeInfo');
        return (
          <pre key={key} className={styles.pre}>
            {info && <span className={styles.lang}>{this.text.slice(info.from, info.to)}</span>}
            <code>{this.codeText(node)}</code>
          </pre>
        );
      }
      case 'HorizontalRule':
        return <hr key={key} />;
      case 'Table': {
        const align = this.alignments(node);
        const header = node.getChild('TableHeader');
        return (
          <div key={key} className={styles.tableWrap}>
            <table>
              {header && <thead>{this.row(header, true, align)}</thead>}
              <tbody>
                {node.getChildren('TableRow').map((row) => this.row(row, false, align))}
              </tbody>
            </table>
          </div>
        );
      }
      case 'HTMLBlock':
      case 'CommentBlock':
      case 'ProcessingInstructionBlock':
      case 'LinkReference':
        return (
          <pre key={key} className={styles.raw}>
            {this.textRange(node.from, node.to, true)}
          </pre>
        );
      default:
        return <p key={key}>{this.inline(node)}</p>;
    }
  }
}

interface MarkdownBlockViewProps {
  text: string;
  block: MarkdownBlock;
  marks: InlineMarks | null;
}

/** One block of the rendered document; a list item renders as the content of its `<li>`. */
export function MarkdownBlockView({ text, block, marks }: MarkdownBlockViewProps) {
  const renderer = new Renderer(text, marks);
  let content: ReactNode;
  if (!block.node) {
    content = <pre className={styles.raw}>{renderer.textRange(block.from, block.to, true)}</pre>;
  } else if (block.type === 'ListItem') {
    content = renderer.itemContent(block.node, block.list?.tight ?? true);
  } else {
    content = renderer.block(block.node);
  }
  return (
    <>
      {content}
      {renderer.leftovers()}
    </>
  );
}

/** `value` of a top-level ordered list item. */
export function listItemNumber(text: string, block: MarkdownBlock): number | undefined {
  return block.node ? new Renderer(text, null).itemNumber(block.node) : undefined;
}
