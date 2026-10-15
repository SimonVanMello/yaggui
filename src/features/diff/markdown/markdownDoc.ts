import { GFM, parser } from '@lezer/markdown';

const markdownParser = parser.configure(GFM);

/** Named through the parser: `@lezer/common` is not a direct dependency. */
export type SyntaxNode = ReturnType<typeof markdownParser.parse>['topNode'];

export type ListKind = 'bullet' | 'ordered';

/**
 * A unit of the rendered diff: a top-level block, or one item of a top-level list (a change in
 * one item must not mark the whole list).
 */
export interface MarkdownBlock {
  /** Lezer node name (`Paragraph`, `ATXHeading2`, `ListItem`…), `FrontMatter` for YAML front matter. */
  type: string;
  from: number;
  to: number;
  /** `null` for the front matter, which the Markdown parser does not know. */
  node: SyntaxNode | null;
  /** Set on list items: the list they belong to. */
  list: { kind: ListKind; tight: boolean } | null;
  /** What two versions of the block are compared on (list marks left out: renumbering is no change). */
  key: string;
}

export interface MarkdownDoc {
  text: string;
  blocks: MarkdownBlock[];
}

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** A list is tight when no blank line separates its items (their paragraphs render inline). */
export function isTight(list: SyntaxNode, text: string): boolean {
  for (let item = list.firstChild; item; item = item.nextSibling) {
    const next = item.nextSibling;
    if (next && /\n[ \t]*\r?\n/.test(text.slice(item.to, next.from))) return false;
    for (let child = item.firstChild; child; child = child.nextSibling) {
      const after = child.nextSibling;
      if (after && /\n[ \t]*\r?\n/.test(text.slice(child.to, after.from))) return false;
    }
  }
  return true;
}

function keyOf(type: string, text: string, from: number, to: number): string {
  return `${type}\u0000${text.slice(from, to).trimEnd()}`;
}

export function parseMarkdown(text: string): MarkdownDoc {
  const blocks: MarkdownBlock[] = [];
  // Blanked rather than cut so that every offset stays the one of `text`.
  const front = FRONT_MATTER.exec(text);
  const source = front ? front[0].replace(/[^\r\n]/g, ' ') + text.slice(front[0].length) : text;
  if (front) {
    const to = front[0].trimEnd().length;
    blocks.push({
      type: 'FrontMatter',
      from: 0,
      to,
      node: null,
      list: null,
      key: keyOf('FrontMatter', text, 0, to),
    });
  }
  const tree = markdownParser.parse(source);
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name === 'BulletList' || node.name === 'OrderedList') {
      const list = {
        kind: node.name === 'BulletList' ? ('bullet' as const) : ('ordered' as const),
        tight: isTight(node, text),
      };
      for (let item = node.firstChild; item; item = item.nextSibling) {
        if (item.name !== 'ListItem') continue;
        const mark = item.getChild('ListMark');
        blocks.push({
          type: 'ListItem',
          from: item.from,
          to: item.to,
          node: item,
          list,
          key: `${list.kind}\u0000${keyOf('ListItem', text, mark?.to ?? item.from, item.to)}`,
        });
      }
    } else {
      blocks.push({
        type: node.name,
        from: node.from,
        to: node.to,
        node,
        list: null,
        key: keyOf(node.name, text, node.from, node.to),
      });
    }
  }
  return { text, blocks };
}
