import type {
  TreeEntry,
  TreeEntryKind,
  TreeFile,
  TreeFileContent,
  TreePage,
  YagguiError,
} from '../bindings';
import type { MockGraph } from '../mockGraph';
import { invalidPath, mockFileText } from './inspect';

type Result<T> = { ok: T } | { error: YagguiError };

const PAGE_MAX = 500;
/** Same limits as the backend (`MAX_RENDER_BYTES`, `MAX_IMAGE_PREVIEW`). */
const MAX_RENDER_BYTES = 1024 * 1024;
const MANY_FILES = 1_200;

type Variant = 'text' | 'latin1' | 'image' | 'binary' | 'lfs' | 'big' | 'symlink' | 'submodule';

interface MockNode {
  path: string;
  kind: Exclude<TreeEntryKind, 'dir'>;
  variant: Variant;
  /** Text of files that change from a commit to the next one; the others never change. */
  versioned?: boolean;
  /** Only in the commits whose id is odd, so two commits show different trees. */
  oddOnly?: boolean;
}

const text = (path: string, versioned = false): MockNode => ({
  path,
  kind: 'file',
  variant: 'text',
  versioned,
});

const SHOWCASE: readonly MockNode[] = [
  text('README.md'),
  text('package.json'),
  text('.gitignore'),
  text('src/main.tsx', true),
  text('src/app/App.tsx', true),
  text('src/app/Thing.ts', true),
  text('src/features/graph/GraphView.tsx', true),
  text('src/features/graph/drawGraph.ts', true),
  text('src-tauri/src/lib.rs', true),
  text('src-tauri/Cargo.toml'),
  text('docs/SPEC.md'),
  { ...text('docs/changelog.md'), oddOnly: true },
  { path: 'docs/readme-link', kind: 'symlink', variant: 'symlink' },
  // Not UTF-8: decoded as Windows-1252, like the backend.
  { path: 'docs/legacy-notes.txt', kind: 'file', variant: 'latin1' },
  { path: 'scripts/run.sh', kind: 'executable', variant: 'text' },
  { path: 'assets/logo.png', kind: 'file', variant: 'image' },
  { path: 'assets/archive.bin', kind: 'file', variant: 'binary' },
  { path: 'assets/model.bin', kind: 'file', variant: 'lfs' },
  { path: 'data/huge-dump.txt', kind: 'file', variant: 'big' },
  { path: 'libs/vendored', kind: 'submodule', variant: 'submodule' },
];

const MANY: readonly MockNode[] = Array.from({ length: MANY_FILES }, (_, i) =>
  text(`vendor/many/file${String(i).padStart(4, '0')}.txt`),
);

const NODES: readonly MockNode[] = [...SHOWCASE, ...MANY];
const BY_PATH = new Map(NODES.map((node) => [node.path, node]));

const LOGO =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96'>" +
  "<rect width='96' height='96' rx='16' fill='%23f5a524'/><path d='M20 70 48 22l28 48z' " +
  "fill='%23fff'/></svg>";

function invalid(en: string, fr: string): YagguiError {
  return {
    code: 'invalidArgument',
    message: { en, fr },
    action: null,
    detail: null,
    payload: null,
  };
}

function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

function resolveRev(graph: MockGraph, rev: string): Result<string> {
  const index = rev.trim() === '' || rev.startsWith('-') ? null : graph.resolve(rev);
  const sha = index === null ? undefined : graph.history.commits[index]?.sha;
  if (sha === undefined) {
    return {
      error: {
        code: 'revisionNotFound',
        message: {
          en: `No commit matches "${rev}".`,
          fr: `Aucun commit ne correspond à « ${rev} ».`,
        },
        action: null,
        detail: null,
        payload: null,
      },
    };
  }
  return { ok: sha };
}

function present(node: MockNode, sha: string): boolean {
  return !node.oddOnly || parseInt(sha.slice(-1), 16) % 2 === 1;
}

function contentText(node: MockNode, sha: string): string {
  if (node.kind === 'executable') return '#!/bin/sh\nset -e\necho "build"\n';
  if (node.variant === 'big') return 'x'.repeat(MAX_RENDER_BYTES + 200_000);
  if (node.variant === 'latin1') return 'Café crème – résumé\n';
  return mockFileText(node.path, node.versioned ? hash(sha) : 0);
}

function sizeOf(node: MockNode, sha: string): number | null {
  switch (node.variant) {
    case 'submodule':
      return null;
    case 'symlink':
      return '../README.md'.length;
    case 'image':
      return LOGO.length;
    case 'binary':
      return 48_213;
    case 'lfs':
      return 130;
    default:
      return contentText(node, sha).length;
  }
}

function oidOf(path: string, sha: string, versioned: boolean): string {
  const seed = hash(`${path}@${versioned ? sha : ''}`)
    .toString(16)
    .padStart(8, '0');
  return seed.repeat(5);
}

/** Folders and files directly under `folder` (`''` is the root), as the backend sorts them. */
function children(sha: string, folder: string): Map<string, TreeEntry> {
  const prefix = folder === '' ? '' : `${folder}/`;
  const out = new Map<string, TreeEntry>();
  for (const node of NODES) {
    if (!node.path.startsWith(prefix) || !present(node, sha)) continue;
    const rest = node.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash >= 0) {
      const name = rest.slice(0, slash);
      out.set(name, { name, kind: 'dir', oid: oidOf(`${prefix}${name}`, sha, false), size: null });
    } else {
      out.set(rest, {
        name: rest,
        kind: node.kind,
        oid: oidOf(node.path, sha, node.versioned === true),
        size: sizeOf(node, sha),
      });
    }
  }
  return out;
}

export function mockTreeList(
  graph: MockGraph,
  rev: string,
  path: string,
  start: number,
  limit: number,
): Result<TreePage> {
  const resolved = resolveRev(graph, rev);
  if ('error' in resolved) return resolved;
  if (path !== '') {
    const bad = invalidPath(path);
    if (bad) return { error: bad };
  }
  const entries = [...children(resolved.ok, path).values()];
  if (path !== '' && entries.length === 0) {
    return {
      error: invalid(
        `"${path}" does not exist in ${rev}.`,
        `« ${path} » n'existe pas dans ${rev}.`,
      ),
    };
  }
  // `dirs_first` in `git/read/tree.rs`: code point order of the lowercased names, then the
  // names themselves, never the locale's collation.
  const order = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  entries.sort(
    (a, b) =>
      Number(b.kind === 'dir') - Number(a.kind === 'dir') ||
      order(a.name.toLowerCase(), b.name.toLowerCase()) ||
      order(a.name, b.name),
  );
  const size = Math.max(1, Math.min(limit, PAGE_MAX));
  return {
    ok: {
      rev: resolved.ok,
      path,
      entries: entries.slice(start, start + size),
      total: entries.length,
    },
  };
}

export function mockTreeFile(
  graph: MockGraph,
  rev: string,
  path: string,
  force: boolean,
): Result<TreeFile> {
  const bad = invalidPath(path);
  if (bad) return { error: bad };
  const resolved = resolveRev(graph, rev);
  if ('error' in resolved) return resolved;
  const sha = resolved.ok;
  const node = BY_PATH.get(path);
  if (!node || !present(node, sha)) {
    return {
      error: invalid(
        `"${path}" does not exist in ${rev}.`,
        `« ${path} » n'existe pas dans ${rev}.`,
      ),
    };
  }
  const file = (content: TreeFileContent, size = sizeOf(node, sha)): Result<TreeFile> => ({
    ok: {
      rev: sha,
      path,
      oid: oidOf(path, sha, node.versioned === true),
      size: size ?? 0,
      executable: node.kind === 'executable',
      content,
    },
  });
  switch (node.variant) {
    case 'submodule':
      return file({
        kind: 'submodule',
        commit: hash(path).toString(16).padStart(8, '0').repeat(5),
      });
    case 'symlink':
      return file({ kind: 'symlink', target: '../README.md' });
    case 'image':
      return file({ kind: 'image', url: LOGO });
    case 'binary':
      return file({ kind: 'binary' });
    case 'lfs':
      return file({
        kind: 'lfs',
        object: { oid: `sha256:${'a'.repeat(64)}`, size: 734_003_200 },
      });
    case 'latin1':
      return file({ kind: 'text', text: contentText(node, sha), encoding: 'windows1252' });
    case 'big':
      if (!force) return file({ kind: 'tooLarge', limit: MAX_RENDER_BYTES });
      return file({ kind: 'text', text: contentText(node, sha), encoding: 'utf8' });
    default:
      return file({ kind: 'text', text: contentText(node, sha), encoding: 'utf8' });
  }
}

/** Paths a "Save as…" can write in the mock (everything but a submodule). */
export function mockTreeSavable(graph: MockGraph, rev: string, path: string): Result<string> {
  const file = mockTreeFile(graph, rev, path, false);
  if ('error' in file) return file;
  if (file.ok.content.kind === 'submodule') {
    return {
      error: invalid(
        `"${path}" is a submodule: it has no file content to save.`,
        `« ${path} » est un sous-module : il n'a pas de contenu à enregistrer.`,
      ),
    };
  }
  return { ok: path.slice(path.lastIndexOf('/') + 1) };
}
