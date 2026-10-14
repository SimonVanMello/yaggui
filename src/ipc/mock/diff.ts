import type {
  ChangedFile,
  ChangedFiles,
  DiffContent,
  DiffOptions,
  DiffTarget,
  DirtyState,
  FileDiff,
  YagguiError,
} from '../bindings';
import {
  MOCK_SHOWCASE_COMMIT,
  MOCK_SHOWCASE_PARENT,
  showcaseChanges,
  type MockFileChange,
} from './diffData';
import { historyFileChange } from './inspect';
import { MAX_RENDER_BYTES, MAX_RENDER_LINES, renderedLines, textDiff } from './lineDiff';
import { blobId, MockWip } from './wip';

export { MOCK_SHOWCASE_COMMIT, MOCK_SHOWCASE_PARENT } from './diffData';

type Result<T> = { ok: T } | { error: YagguiError };

function invalid(en: string, fr: string): YagguiError {
  return {
    code: 'invalidArgument',
    message: { en, fr },
    action: null,
    detail: null,
    payload: null,
  };
}

const encoder = new TextEncoder();
const bytes = (text: string | null) => (text === null ? null : encoder.encode(text).length);

/** Revisions the mock knows: the showcase commit (also `HEAD` of every repo) and its parent. */
function commitChanges(target: Extract<DiffTarget, { kind: 'commits' }>): Result<MockFileChange[]> {
  // Any commit of the mock graph resolves; non-parent ones show the showcase change set.
  const known = (rev: string) =>
    rev === 'HEAD' ||
    /^[0-9a-f]{7,40}$/.test(rev) ||
    MOCK_SHOWCASE_COMMIT.startsWith(rev) ||
    MOCK_SHOWCASE_PARENT.startsWith(rev);
  for (const rev of [target.to, target.from].filter((r): r is string => r !== null)) {
    if (!rev.trim() || rev.startsWith('-') || !known(rev)) {
      return { error: invalid(`Unknown revision "${rev}".`, `Révision inconnue « ${rev} ».`) };
    }
  }
  const isParent = (rev: string) => rev.length >= 4 && MOCK_SHOWCASE_PARENT.startsWith(rev);
  // Parent → showcase is the showcase; showcase → parent is the reverse; same → nothing. Two
  // other commits (compared from the graph, F-029) show the showcase too.
  const from = target.from ?? MOCK_SHOWCASE_PARENT;
  if (from === target.to || (isParent(target.to) && isParent(from))) return { ok: [] };
  const changes = showcaseChanges();
  if (!isParent(target.to)) return { ok: changes };
  return {
    ok: changes.map((c) => ({
      ...c,
      path: c.oldPath ?? c.path,
      oldPath: c.oldPath ? c.path : undefined,
      status: c.status === 'added' ? 'deleted' : c.status === 'deleted' ? 'added' : c.status,
      oldMode: c.newMode,
      newMode: c.oldMode,
      old: c.new,
      new: c.old,
    })),
  };
}

/** `wip`: the repository's live working state; a fresh fixture when omitted. */
function changesOf(
  repoName: string,
  dirty: DirtyState,
  target: DiffTarget,
  wip?: MockWip,
): Result<MockFileChange[]> {
  if (target.kind === 'commits') return commitChanges(target);
  return { ok: (wip ?? MockWip.fromFixture(repoName, dirty)).changes(target.kind) };
}

function toFile(change: MockFileChange): ChangedFile {
  const binary = change.binary !== undefined;
  const textual = !binary && !change.submodule && !change.lfs && change.status !== 'conflicted';
  let additions: number | null = null;
  let deletions: number | null = null;
  // Like the backend: a file above the size guard is never loaded for stats.
  if (textual && !change.tooLarge) {
    const diff = textDiff(change.old ?? '', change.new ?? '', {
      ignoreWhitespace: false,
      contextLines: 0,
      fullFile: false,
      force: false,
    });
    additions = diff.additions;
    deletions = diff.deletions;
  }
  return {
    path: change.path,
    oldPath: change.oldPath ?? null,
    status: change.status,
    similarity: change.similarity ?? null,
    additions,
    deletions,
    binary,
    oldMode: change.oldMode,
    newMode: change.newMode,
  };
}

export function mockChangedFiles(
  repoName: string,
  dirty: DirtyState,
  target: DiffTarget,
  wip?: MockWip,
): Result<ChangedFiles> {
  const changes = changesOf(repoName, dirty, target, wip);
  if ('error' in changes) return changes;
  const files = changes.ok.map(toFile).sort((a, b) => (a.path < b.path ? -1 : 1));
  const lfs = changes.ok
    .filter((c) => c.lfs)
    .map((c) => c.path)
    .sort();
  return { ok: { files, statsSkipped: false, lfs } };
}

function content(change: MockFileChange, options: DiffOptions): DiffContent {
  if (change.status === 'conflicted') return { kind: 'conflict' };
  if (change.submodule) return { kind: 'submodule', ...change.submodule };
  if (change.lfs) return { kind: 'lfs', ...change.lfs };
  if (change.binary) return { kind: 'binary', ...change.binary };
  // Size guard before loading, as the backend: the line count is unknown.
  if (change.tooLarge && !options.force)
    return { kind: 'tooLarge', ...change.tooLarge, lines: null };
  const old = change.old ?? '';
  const now =
    change.new ??
    (change.tooLarge
      ? Array.from({ length: 40_000 }, (_, i) => `{"row": ${String(i)}}`).join('\n')
      : '');
  const diff = textDiff(old, now, options);
  diff.oldEncoding = change.oldEncoding ?? 'utf8';
  diff.newEncoding = change.newEncoding ?? 'utf8';
  const largest = Math.max(bytes(change.old) ?? 0, bytes(change.new) ?? 0);
  if (!options.force && largest > MAX_RENDER_BYTES) {
    return {
      kind: 'tooLarge',
      oldSize: bytes(change.old),
      newSize: bytes(change.new),
      lines: null,
    };
  }
  const lines = renderedLines(diff);
  if (!options.force && lines > MAX_RENDER_LINES) {
    return { kind: 'tooLarge', oldSize: bytes(change.old), newSize: bytes(change.new), lines };
  }
  return { kind: 'text', ...diff };
}

export function mockFileDiff(
  repoName: string,
  dirty: DirtyState,
  target: DiffTarget,
  path: string,
  oldPath: string | null,
  options: DiffOptions,
  wip?: MockWip,
): Result<FileDiff> {
  for (const p of [path, oldPath]) {
    if (p !== null && (!p.trim() || p.startsWith('/') || p.split('/').includes('..'))) {
      return {
        error: invalid(
          `Expected a path relative to the repository, got "${p}".`,
          `Chemin relatif au dépôt attendu, reçu « ${p} ».`,
        ),
      };
    }
  }
  const changes = changesOf(repoName, dirty, target, wip);
  if ('error' in changes) return changes;
  // A commit of a file history (M4-4) that the showcase change set does not list.
  const change =
    changes.ok.find((c) => c.path === path) ??
    (target.kind === 'commits' && target.from === null
      ? historyFileChange(target.to, path, oldPath)
      : undefined);
  if (!change) {
    return {
      error: invalid(`"${path}" has no changes here.`, `« ${path} » n'a pas de modification ici.`),
    };
  }
  return {
    ok: {
      path,
      oldPath,
      // Like the backend, a worktree file has the id `git hash-object` would give it.
      oldId: blobId(change.old),
      newId: blobId(change.new),
      oldMode: change.oldMode,
      newMode: change.newMode,
      content: content(change, options),
    },
  };
}
