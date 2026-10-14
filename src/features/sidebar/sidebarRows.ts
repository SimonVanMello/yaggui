import type {
  HeadState,
  LocalBranch,
  RemoteBranch,
  RepoRefs,
  StashRef,
  SubmoduleRef,
  TagRef,
  WorktreeRef,
} from '../../ipc';

export type SectionId = 'local' | 'remote' | 'tags' | 'stashes' | 'submodules' | 'worktrees';

export const SECTIONS: readonly SectionId[] = [
  'local',
  'remote',
  'tags',
  'stashes',
  'submodules',
  'worktrees',
];

/** What a leaf row designates. */
export type RefTarget =
  /** Detached HEAD (with its commit) or unborn branch (no commit). */
  | { kind: 'head'; head: HeadState }
  | { kind: 'local'; branch: LocalBranch }
  | { kind: 'remote'; branch: RemoteBranch; remote: string }
  | { kind: 'tag'; tag: TagRef }
  | { kind: 'stash'; stash: StashRef }
  | { kind: 'submodule'; submodule: SubmoduleRef }
  | { kind: 'worktree'; worktree: WorktreeRef };

interface RowBase {
  /** Stable id, also the key of the expanded state. */
  key: string;
  section: SectionId;
  /** ARIA tree level, 1 for sections. */
  level: number;
  /** Position among its siblings (1-based) and number of siblings, for ARIA. */
  posInSet: number;
  setSize: number;
  /** Key of the parent row, `null` for sections. */
  parent: string | null;
}

export interface SectionRow extends RowBase {
  type: 'section';
  count: number;
  expanded: boolean;
}

export interface FolderRow extends RowBase {
  type: 'folder';
  label: string;
  /** Path of the folder, `feat/graph` (remotes: `origin` or `origin/feat`). */
  path: string;
  /** Remote folder at the top of the Remote section. */
  remote: boolean;
  count: number;
  expanded: boolean;
  highlight: number[];
}

export interface RefRow extends RowBase {
  type: 'ref';
  label: string;
  highlight: number[];
  target: RefTarget;
}

/** Placeholder line of an expanded section without items (not focusable). */
export interface EmptyRow extends RowBase {
  type: 'empty';
}

export type SidebarRow = SectionRow | FolderRow | RefRow | EmptyRow;

export interface TreeOptions {
  /** Expanded state toggled by the user; other nodes use `defaultExpanded`. */
  open: Readonly<Record<string, boolean>>;
  flat: boolean;
  /** Raw filter text; empty for no filter. */
  filter: string;
}

/** Collapsed by default: long and rarely needed lists. */
const COLLAPSED_SECTIONS: ReadonlySet<SectionId> = new Set(['tags', 'submodules', 'worktrees']);

export function sectionKey(section: SectionId): string {
  return `s:${section}`;
}

export function defaultExpanded(key: string): boolean {
  if (key.startsWith('s:')) return !COLLAPSED_SECTIONS.has(key.slice(2) as SectionId);
  return true;
}

export function filterTokens(filter: string): string[] {
  return filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Indices of `text` covered by the tokens, or `null` when one token is missing (every token
 * must match, anywhere, ignoring case).
 */
export function matchAll(text: string, tokens: readonly string[]): number[] | null {
  const lower = text.toLowerCase();
  const marked = new Set<number>();
  for (const token of tokens) {
    const at = lower.indexOf(token);
    if (at === -1) return null;
    for (let i = 0; i < token.length; i++) marked.add(at + i);
  }
  return [...marked].sort((a, b) => a - b);
}

/** Indices of `text` covered by any occurrence of any token (folder labels). */
export function highlightAny(text: string, tokens: readonly string[]): number[] {
  const lower = text.toLowerCase();
  const marked = new Set<number>();
  for (const token of tokens) {
    for (let at = lower.indexOf(token); at !== -1; at = lower.indexOf(token, at + 1)) {
      for (let i = 0; i < token.length; i++) marked.add(at + i);
    }
  }
  return [...marked].sort((a, b) => a - b);
}

/** Message of a stash without Git's `WIP on main:` / `On main:` prefix. */
export function stashTitle(message: string): string {
  return message.replace(/^(WIP on|On) [^:]+:\s*/, '') || message;
}

/** Last segment of a path, for worktree labels. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Text the filter looks into, beyond the label (full names, messages, paths). */
function searchText(target: RefTarget): string {
  switch (target.kind) {
    case 'head':
      return target.head.kind === 'detached'
        ? `HEAD ${target.head.oid}`
        : `HEAD ${target.head.name}`;
    case 'local':
    case 'remote':
      return target.branch.name;
    case 'tag':
      return target.tag.name;
    case 'stash':
      return `${target.stash.name} ${target.stash.message}`;
    case 'submodule':
      return `${target.submodule.name} ${target.submodule.path}`;
    case 'worktree': {
      const { head, path } = target.worktree;
      return `${path} ${head?.kind === 'detached' || !head ? '' : head.name}`;
    }
  }
}

// ── Intermediate tree ────────────────────────────────────────────────────────

interface LeafNode {
  type: 'ref';
  key: string;
  label: string;
  highlight: number[];
  target: RefTarget;
}

interface FolderNode {
  type: 'folder';
  key: string;
  label: string;
  path: string;
  remote: boolean;
  highlight: number[];
  children: Node[];
  count: number;
}

type Node = LeafNode | FolderNode;

interface Leaf {
  /** Display name split into folders: `feat/graph/lanes`. */
  name: string;
  key: string;
  target: RefTarget;
  /** Offset of `name` in the text the highlight indices refer to. */
  highlight: number[];
}

/** Builds the folder tree of names split on `/`. Leaves come before folders (cf. mockup). */
function groupByPrefix(
  leaves: Leaf[],
  section: SectionId,
  prefix: string,
  tokens: readonly string[],
): Node[] {
  const direct: Node[] = [];
  const folders = new Map<string, Leaf[]>();
  for (const leaf of leaves) {
    const slash = leaf.name.indexOf('/');
    if (slash === -1) {
      direct.push({
        type: 'ref',
        key: leaf.key,
        label: leaf.name,
        highlight: leaf.highlight,
        target: leaf.target,
      });
      continue;
    }
    const folder = leaf.name.slice(0, slash);
    const rest = leaf.name.slice(slash + 1);
    const shift = slash + 1;
    const list = folders.get(folder) ?? [];
    list.push({
      ...leaf,
      name: rest,
      highlight: leaf.highlight.filter((i) => i >= shift).map((i) => i - shift),
    });
    folders.set(folder, list);
  }
  const nested: Node[] = [];
  for (const [folder, children] of folders) {
    const path = prefix ? `${prefix}/${folder}` : folder;
    const nodes = groupByPrefix(children, section, path, tokens);
    nested.push({
      type: 'folder',
      key: `f:${section}:${path}`,
      label: folder,
      path,
      remote: false,
      highlight: highlightAny(folder, tokens),
      children: nodes,
      count: children.length,
    });
  }
  return [...direct, ...nested];
}

function leafNode(key: string, label: string, target: RefTarget, highlight: number[]): LeafNode {
  return { type: 'ref', key, label, target, highlight };
}

/** Matches a leaf against the filter: the label first (for highlighting), then other text. */
function matchLeaf(label: string, target: RefTarget, tokens: readonly string[]): number[] | null {
  if (tokens.length === 0) return [];
  const onLabel = matchAll(label, tokens);
  if (onLabel) return onLabel;
  return matchAll(`${label} ${searchText(target)}`, tokens) ? highlightAny(label, tokens) : null;
}

function branchLeaves<B extends LocalBranch | RemoteBranch>(
  branches: readonly B[],
  name: (branch: B) => string,
  key: (branch: B) => string,
  target: (branch: B) => RefTarget,
  tokens: readonly string[],
): Leaf[] {
  const leaves: Leaf[] = [];
  for (const branch of branches) {
    const display = name(branch);
    const highlight = tokens.length === 0 ? [] : matchAll(display, tokens);
    if (!highlight) continue;
    leaves.push({ name: display, key: key(branch), target: target(branch), highlight });
  }
  return leaves;
}

function asLeaves(leaves: Leaf[]): Node[] {
  return leaves.map((leaf) => leafNode(leaf.key, leaf.name, leaf.target, leaf.highlight));
}

function sectionNodes(
  refs: RepoRefs,
  section: SectionId,
  flat: boolean,
  tokens: readonly string[],
): { nodes: Node[]; count: number } {
  switch (section) {
    case 'local': {
      const nodes: Node[] = [];
      const { head } = refs;
      const headLabel = head.kind === 'detached' ? 'HEAD' : head.name;
      const headTarget: RefTarget = { kind: 'head', head };
      let count = 0;
      // Detached or unborn HEAD has no branch row: a pseudo-row keeps "where am I" visible.
      if (head.kind !== 'branch') {
        const highlight = matchLeaf(headLabel, headTarget, tokens);
        if (highlight) {
          nodes.push(leafNode('r:head', headLabel, headTarget, highlight));
          count += 1;
        }
      }
      const leaves = branchLeaves(
        refs.local,
        (b) => b.name,
        (b) => `r:local:${b.fullName}`,
        (branch) => ({ kind: 'local', branch }),
        tokens,
      );
      nodes.push(...(flat ? asLeaves(leaves) : groupByPrefix(leaves, 'local', '', tokens)));
      return { nodes, count: count + leaves.length };
    }
    case 'remote': {
      const nodes: Node[] = [];
      let count = 0;
      for (const remote of refs.remotes) {
        const prefix = `${remote.name}/`;
        // A filter matching the remote name keeps all its branches.
        const remoteMatches = tokens.length > 0 && matchAll(remote.name, tokens) !== null;
        const kept = branchLeaves(
          remote.branches,
          (b) => (b.name.startsWith(prefix) ? b.name.slice(prefix.length) : b.name),
          (b) => `r:remote:${b.fullName}`,
          (branch) => ({ kind: 'remote', branch, remote: remote.name }),
          remoteMatches ? [] : tokens,
        );
        if (tokens.length > 0 && kept.length === 0) continue;
        count += kept.length;
        nodes.push({
          type: 'folder',
          key: `f:remote:${remote.name}`,
          label: remote.name,
          path: remote.name,
          remote: true,
          highlight: highlightAny(remote.name, tokens),
          children: flat ? asLeaves(kept) : groupByPrefix(kept, 'remote', remote.name, tokens),
          count: kept.length,
        });
      }
      return { nodes, count };
    }
    case 'tags': {
      const nodes: Node[] = [];
      for (const tag of refs.tags) {
        const target: RefTarget = { kind: 'tag', tag };
        const highlight = matchLeaf(tag.name, target, tokens);
        if (highlight) nodes.push(leafNode(`r:tag:${tag.fullName}`, tag.name, target, highlight));
      }
      return { nodes, count: nodes.length };
    }
    case 'stashes': {
      const nodes: Node[] = [];
      for (const stash of refs.stashes) {
        const target: RefTarget = { kind: 'stash', stash };
        const label = stashTitle(stash.message);
        const highlight = matchLeaf(label, target, tokens);
        if (highlight) nodes.push(leafNode(`r:stash:${stash.sha}`, label, target, highlight));
      }
      return { nodes, count: nodes.length };
    }
    case 'submodules': {
      const nodes: Node[] = [];
      for (const submodule of refs.submodules) {
        const target: RefTarget = { kind: 'submodule', submodule };
        const highlight = matchLeaf(submodule.name, target, tokens);
        if (highlight) {
          nodes.push(leafNode(`r:sub:${submodule.path}`, submodule.name, target, highlight));
        }
      }
      return { nodes, count: nodes.length };
    }
    case 'worktrees': {
      const nodes: Node[] = [];
      for (const worktree of refs.worktrees) {
        const target: RefTarget = { kind: 'worktree', worktree };
        const label = baseName(worktree.path);
        const highlight = matchLeaf(label, target, tokens);
        if (highlight) nodes.push(leafNode(`r:wt:${worktree.path}`, label, target, highlight));
      }
      return { nodes, count: nodes.length };
    }
  }
}

// ── Flattening ───────────────────────────────────────────────────────────────

export interface SidebarTree {
  rows: SidebarRow[];
  /** Number of matching refs; equals the total without filter. */
  matches: number;
  filtering: boolean;
}

/**
 * Visible rows of the sidebar, in order, for the virtualized tree. With a filter, sections
 * and folders without a match disappear and every remaining node is expanded unless the
 * user collapsed it during this filter (`open` then holds filter-time overrides).
 */
export function buildSidebarRows(refs: RepoRefs, options: TreeOptions): SidebarTree {
  const tokens = filterTokens(options.filter);
  const filtering = tokens.length > 0;
  const expanded = (key: string) => options.open[key] ?? (filtering ? true : defaultExpanded(key));
  const rows: SidebarRow[] = [];
  let matches = 0;

  const built = SECTIONS.map((section) => ({
    section,
    ...sectionNodes(refs, section, options.flat, tokens),
  })).filter((s) => !filtering || s.nodes.length > 0);

  const pushNodes = (nodes: Node[], section: SectionId, level: number, parent: string) => {
    nodes.forEach((node, index) => {
      const base = {
        key: node.key,
        section,
        level,
        posInSet: index + 1,
        setSize: nodes.length,
        parent,
      };
      if (node.type === 'ref') {
        rows.push({
          ...base,
          type: 'ref',
          label: node.label,
          highlight: node.highlight,
          target: node.target,
        });
        return;
      }
      const open = expanded(node.key);
      rows.push({
        ...base,
        type: 'folder',
        label: node.label,
        path: node.path,
        remote: node.remote,
        count: node.count,
        expanded: open,
        highlight: node.highlight,
      });
      if (open) pushNodes(node.children, section, level + 1, node.key);
    });
  };

  built.forEach(({ section, nodes, count }, index) => {
    const key = sectionKey(section);
    const open = expanded(key);
    matches += count;
    rows.push({
      type: 'section',
      key,
      section,
      level: 1,
      posInSet: index + 1,
      setSize: built.length,
      parent: null,
      count,
      expanded: open,
    });
    if (!open) return;
    if (nodes.length === 0) {
      rows.push({
        type: 'empty',
        key: `e:${section}`,
        section,
        level: 2,
        posInSet: 1,
        setSize: 1,
        parent: key,
      });
      return;
    }
    pushNodes(nodes, section, 2, key);
  });

  return { rows, matches, filtering };
}

/** Commit a ref row points at in the graph, `null` when it has none in this repository. */
export function targetCommit(target: RefTarget): { sha: string; row: number | null } | null {
  switch (target.kind) {
    case 'head':
      return target.head.kind === 'detached' ? { sha: target.head.oid, row: null } : null;
    case 'local':
    case 'remote':
      return { sha: target.branch.sha, row: target.branch.row };
    case 'tag':
      return { sha: target.tag.sha, row: target.tag.row };
    case 'stash':
      // Stashes are labels on their base commit in the graph.
      return { sha: target.stash.baseSha, row: target.stash.row };
    case 'worktree': {
      const { head } = target.worktree;
      if (!head || head.kind === 'unborn') return null;
      return { sha: head.oid, row: null };
    }
    case 'submodule':
      // The recorded commit belongs to the submodule's own history.
      return null;
  }
}

/** Name copied by "Copy name". */
export function targetName(target: RefTarget): string {
  switch (target.kind) {
    case 'head':
      return target.head.kind === 'detached' ? target.head.oid : target.head.name;
    case 'local':
    case 'remote':
      return target.branch.name;
    case 'tag':
      return target.tag.name;
    case 'stash':
      return target.stash.name;
    case 'submodule':
      return target.submodule.path;
    case 'worktree':
      return target.worktree.path;
  }
}

/** SHA copied by "Copy SHA", `null` when there is none. */
export function targetSha(target: RefTarget): string | null {
  switch (target.kind) {
    case 'stash':
      return target.stash.sha;
    case 'submodule':
      return target.submodule.sha;
    default:
      return targetCommit(target)?.sha ?? null;
  }
}
