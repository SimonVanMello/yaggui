/** Pure model of the tree at a commit (M7-8): flat rows of the open folders, and the keyboard. */
import type { TreeEntry } from '../../ipc';

/** The pages of a folder loaded so far. */
export interface Listing {
  entries: readonly TreeEntry[];
  /** Entries in the whole folder; more than `entries.length` while pages are coming. */
  total: number;
}

export type TreeRow =
  | {
      kind: 'entry';
      /** Full path in the repository: the key of the row. */
      path: string;
      depth: number;
      entry: TreeEntry;
      /** Open folder (always `false` for files). */
      expanded: boolean;
    }
  | {
      kind: 'loading';
      /** Folder being loaded. */
      path: string;
      depth: number;
    }
  | {
      kind: 'empty';
      /** Folder without any entry. */
      path: string;
      depth: number;
    };

export function joinPath(folder: string, name: string): string {
  return folder === '' ? name : `${folder}/${name}`;
}

export function parentPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** Folders to open to see `path`: `a/b/c.txt` → `a`, `a/b`. */
export function ancestorFolders(path: string): string[] {
  const parts = path.split('/').slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** Key of a row, stable while the list changes around it. */
export function rowKey(row: TreeRow): string {
  return row.kind === 'entry' ? row.path : `${row.path}\0${row.kind}`;
}

/**
 * The visible rows: the entries of the root and of every open folder, depth first, in the
 * order the backend sorts them. A folder that is open but not loaded (or still loading its
 * later pages) ends with a "loading" row.
 */
export function flattenTree(
  listings: ReadonlyMap<string, Listing>,
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (folder: string, depth: number) => {
    const listing = listings.get(folder);
    for (const entry of listing?.entries ?? []) {
      const path = joinPath(folder, entry.name);
      const open = entry.kind === 'dir' && expanded.has(path);
      rows.push({ kind: 'entry', path, depth, entry, expanded: open });
      if (open) walk(path, depth + 1);
    }
    if (!listing || listing.entries.length < listing.total) {
      rows.push({ kind: 'loading', path: folder, depth });
    } else if (listing.total === 0) {
      rows.push({ kind: 'empty', path: folder, depth });
    }
  };
  walk('', 0);
  return rows;
}

export type TreeKey = 'ArrowDown' | 'ArrowUp' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

export interface TreeMove {
  /** Row to make active. */
  active: string;
  /** Folder to open or close with the move. */
  toggle?: { path: string; open: boolean };
}

/**
 * What a navigation key does (WAI-ARIA tree pattern): up / down move through the visible
 * rows, right opens a folder or enters it, left closes it or goes to the parent folder.
 * `active` is `null` before any row is active: the first row is then reached.
 */
export function moveInTree(
  rows: readonly TreeRow[],
  active: string | null,
  key: TreeKey,
): TreeMove | null {
  const entries = rows.filter((row) => row.kind === 'entry');
  if (entries.length === 0) return null;
  const index = entries.findIndex((row) => row.path === active);
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (!first || !last) return null;
  const current = entries[index];
  switch (key) {
    case 'Home':
      return { active: first.path };
    case 'End':
      return { active: last.path };
    case 'ArrowDown': {
      const next = index < 0 ? first : entries[index + 1];
      return next ? { active: next.path } : null;
    }
    case 'ArrowUp': {
      const previous = index < 0 ? first : entries[index - 1];
      return previous ? { active: previous.path } : null;
    }
    case 'ArrowRight': {
      if (current?.kind !== 'entry' || current.entry.kind !== 'dir') return null;
      if (!current.expanded)
        return { active: current.path, toggle: { path: current.path, open: true } };
      const child = entries[index + 1];
      return child && child.depth > current.depth ? { active: child.path } : null;
    }
    case 'ArrowLeft': {
      if (current?.kind !== 'entry') return null;
      if (current.expanded)
        return { active: current.path, toggle: { path: current.path, open: false } };
      for (let i = index - 1; i >= 0; i--) {
        const candidate = entries[i];
        if (candidate && candidate.depth < current.depth) return { active: candidate.path };
      }
      return null;
    }
  }
}

/**
 * Where a symbolic link points, as a repository path; `null` when the target leaves the
 * repository (absolute, or too many `..`).
 */
export function resolveLinkTarget(linkPath: string, target: string): string | null {
  if (target.startsWith('/') || /^[a-zA-Z]:/.test(target)) return null;
  const parts = parentPath(linkPath) === '' ? [] : parentPath(linkPath).split('/');
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.pop() === undefined) return null;
    } else {
      parts.push(part);
    }
  }
  return parts.length === 0 ? null : parts.join('/');
}
