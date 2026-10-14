import type { ChangedFile } from '../../ipc';

export interface TreeFolder {
  kind: 'folder';
  /** Full path, used as the collapse key. */
  path: string;
  /** Shown name; single-child folder chains are compressed (`src/features`). */
  name: string;
  depth: number;
  fileCount: number;
}

export interface TreeFile {
  kind: 'file';
  file: ChangedFile;
  name: string;
  depth: number;
}

export type TreeRow = TreeFolder | TreeFile;

interface Node {
  folders: Map<string, Node>;
  files: ChangedFile[];
}

function node(): Node {
  return { folders: new Map(), files: [] };
}

function count(n: Node): number {
  let total = n.files.length;
  for (const child of n.folders.values()) total += count(child);
  return total;
}

export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/');
  return slash < 0
    ? { dir: '', name: path }
    : { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

/** Rows of the tree view, folders first, skipping the content of `collapsed` folders. */
export function treeRows(files: readonly ChangedFile[], collapsed: ReadonlySet<string>): TreeRow[] {
  const root = node();
  for (const file of files) {
    const parts = file.path.split('/');
    parts.pop();
    let current = root;
    for (const part of parts) {
      let next = current.folders.get(part);
      if (!next) {
        next = node();
        current.folders.set(part, next);
      }
      current = next;
    }
    current.files.push(file);
  }

  const rows: TreeRow[] = [];
  const walk = (n: Node, prefix: string, depth: number) => {
    const folders = [...n.folders.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [name, child] of folders) {
      let label = name;
      let path = `${prefix}${name}`;
      let target = child;
      // `a/b/c` with no files on the way is one row.
      while (target.files.length === 0 && target.folders.size === 1) {
        const [[nextName, next]] = [...target.folders.entries()] as [[string, Node]];
        label = `${label}/${nextName}`;
        path = `${path}/${nextName}`;
        target = next;
      }
      rows.push({ kind: 'folder', path, name: label, depth, fileCount: count(target) });
      if (!collapsed.has(path)) walk(target, `${path}/`, depth + 1);
    }
    for (const file of n.files) {
      rows.push({ kind: 'file', file, name: splitPath(file.path).name, depth });
    }
  };
  walk(root, '', 0);
  return rows;
}
