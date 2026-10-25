import type {
  Blame,
  BlameChunk,
  BlameCommit,
  BlameContent,
  FileHistoryCursor,
  FileHistoryEntry,
  FileHistoryPage,
  LineHistoryCursor,
  LineHistoryEntry,
  LineHistoryPage,
  LineHistoryRequest,
  TextDiff,
  YagguiError,
  ReflogEntry,
  ReflogPage,
} from '../bindings';
import type { MockCommit, MockGraph } from '../mockGraph';
import { mockSha } from '../mockGraph';
import type { MockFileChange } from './diffData';
import { textDiff } from './lineDiff';
import { ancestors } from './refs';
import type { MockWip } from './wip';

type Result<T> = { ok: T } | { error: YagguiError };

const NULL_SHA = '0'.repeat(40);
const PAGE_MAX = 500;
/** A file history this long or longer starts under another name (a simulated rename). */
const RENAME_FROM = 6;
const BINARY = /\.(png|jpe?g|gif|webp|bmp|ico|avif|pdf|zip|woff2?)$/i;
/** Paths containing this simulate a large file (blame performance, `pnpm perf:blame`). */
export const MOCK_HUGE_FILE_LINES = 20_000;

function invalid(en: string, fr: string): YagguiError {
  return {
    code: 'invalidArgument',
    message: { en, fr },
    action: null,
    detail: null,
    payload: null,
  };
}

function notFound(rev: string): YagguiError {
  return {
    code: 'revisionNotFound',
    message: { en: `No commit matches "${rev}".`, fr: `Aucun commit ne correspond à « ${rev} ».` },
    action: null,
    detail: null,
    payload: null,
  };
}

/** Same rule as the backend (`validate_path`). */
export function invalidPath(path: string): YagguiError | null {
  const parts = path.split('/');
  if (
    !path.trim() ||
    path.startsWith('/') ||
    /^[a-zA-Z]:/.test(path) ||
    parts.some((p) => p === '' || p === '.' || p === '..')
  ) {
    return invalid(
      `Expected a path relative to the repository, got "${path}".`,
      `Chemin relatif au dépôt attendu, reçu « ${path} ».`,
    );
  }
  return null;
}

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Name of the file before the simulated rename. */
export function formerPath(path: string): string {
  return `legacy/${basename(path)}`;
}

interface HistoryItem {
  commit: number;
  entry: FileHistoryEntry;
}

/**
 * Commits that changed `path`, newest first: the commits listing it in the mock graph, or a
 * deterministic sample of the history for other paths. Long histories start as `legacy/<name>`
 * and get renamed, like a `--follow` history.
 */
function historyOf(graph: MockGraph, path: string, start: number): HistoryItem[] {
  const { commits } = graph.history;
  const reachable = ancestors(commits, start);
  const order = graph.order.filter((c) => reachable.has(c));
  let picked = order.filter((c) => commits[c]?.files.includes(path));
  if (picked.length < 3) {
    const salt = hash(path);
    const every = 5 + (salt % 7);
    picked = order.filter((c) => (hash(commits[c]?.sha ?? '') ^ salt) % every === 0);
  }
  const renameAt = picked.length >= RENAME_FROM ? Math.floor((picked.length * 2) / 3) : -1;
  return picked.map((c, index) => {
    const commit = commits[c] as MockCommit;
    const renamed = renameAt >= 0 && index >= renameAt;
    const current = renamed && index > renameAt ? formerPath(path) : path;
    const last = index === picked.length - 1;
    return {
      commit: c,
      entry: {
        sha: commit.sha,
        parents: commit.parents.map((p) => commits[p]?.sha ?? ''),
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
        authorTime: commit.authorTime,
        summary: commit.summary,
        path: current,
        oldPath: index === renameAt ? formerPath(path) : null,
        status: index === renameAt ? 'renamed' : last ? 'added' : 'modified',
        similarity: index === renameAt ? 92 : null,
      },
    };
  });
}

function startCommit(graph: MockGraph, rev: string | null): Result<number | null> {
  if (rev === null) return { ok: graph.headCommit() };
  const commit = rev.startsWith('-') ? null : graph.resolve(rev);
  return commit === null ? { error: notFound(rev) } : { ok: commit };
}

export function mockFileHistory(
  graph: MockGraph,
  path: string,
  rev: string | null,
  cursor: FileHistoryCursor | null,
  limit: number,
): Result<FileHistoryPage> {
  const bad = invalidPath(cursor?.path ?? path);
  if (bad) return { error: bad };
  const start = startCommit(graph, cursor?.rev ?? rev);
  if ('error' in start) return start;
  if (start.ok === null) return { ok: { entries: [], next: null } };
  const name = cursor?.path ?? path;
  const all = historyOf(graph, name, start.ok).map((item) => item.entry);
  const skip = cursor?.skip ?? 0;
  const size = Math.max(1, Math.min(limit, PAGE_MAX));
  const entries = all.slice(skip, skip + size);
  const sha = graph.history.commits[start.ok]?.sha ?? '';
  return {
    ok: {
      entries,
      next: skip + size < all.length ? { rev: sha, path: name, skip: skip + size } : null,
    },
  };
}

/** Same limit as the backend (`LINE_RANGE_MAX`). */
const LINE_RANGE_MAX = 5_000;

function lineCount(text: string): number {
  return text.length === 0
    ? 0
    : (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length;
}

/** A hunk of the HEAD → working tree diff without context, as 0-based line indexes. */
interface Span {
  oldFirst: number;
  oldLines: number;
  newFirst: number;
  newLines: number;
}

/**
 * Port of `map_to_head` (`git/read/line_history.rs`): the working tree lines `start ..= end`
 * (1-based) as HEAD lines. Changed lines stand for the HEAD lines they replace, lines only
 * added are dropped; `null` when no line of the range is in HEAD.
 */
export function mapToHead(
  headText: string,
  worktreeText: string,
  start: number,
  end: number,
): [number, number] | null {
  const diff = textDiff(headText, worktreeText, {
    ignoreWhitespace: false,
    contextLines: 0,
    fullFile: false,
    force: false,
  });
  const spans: Span[] = diff.hunks.map((h) => ({
    // An empty side is numbered by the line before it: its index is the line it sits before.
    oldFirst: h.oldLines === 0 ? h.oldStart : h.oldStart - 1,
    oldLines: h.oldLines,
    newFirst: h.newLines === 0 ? h.newStart : h.newStart - 1,
    newLines: h.newLines,
  }));
  const baseOf = (line: number) => {
    let delta = 0;
    for (const span of spans) {
      if (line < span.newFirst) break;
      if (line < span.newFirst + span.newLines) {
        return { line: span.oldFirst, replaces: span.oldLines as number | null };
      }
      delta += span.oldLines - span.newLines;
    }
    return { line: Math.max(0, line + delta), replaces: null };
  };
  const from = baseOf(Math.max(0, start - 1));
  const to = baseOf(Math.max(0, end - 1));
  const first = from.line + 1;
  const last = to.replaces === null ? to.line + 1 : to.line + to.replaces;
  return first <= last ? [first, last] : null;
}

/** The range `start ..= end` (1-based) as one hunk: old and new lines paired, Git style. */
function rangeDiff(
  old: string[] | null,
  now: string[],
  start: number,
  oldFirst: number = start,
): TextDiff {
  const kinds: string[] = [];
  const lines: string[] = [];
  if (old === null) {
    for (const line of now) {
      kinds.push('+');
      lines.push(line);
    }
  } else {
    for (let i = 0; i < now.length; i++) {
      const before = old[i] ?? '';
      const after = now[i] ?? '';
      if (before === after) {
        kinds.push(' ');
        lines.push(after);
      } else {
        kinds.push('-', '+');
        lines.push(before, after);
      }
    }
  }
  const additions = kinds.filter((k) => k === '+').length;
  const deletions = kinds.filter((k) => k === '-').length;
  const oldLines = old === null ? 0 : now.length;
  const oldStart = old === null ? 0 : oldFirst;
  return {
    hunks: [
      {
        id: `-${String(oldStart)},${String(oldLines)}+${String(start)},${String(now.length)}`,
        oldStart,
        oldLines,
        newStart: start,
        newLines: now.length,
        header: '',
        kinds: kinds.join(''),
        lines,
      },
    ],
    additions,
    deletions,
    oldEncoding: 'utf8',
    newEncoding: 'utf8',
    oldLineEnding: 'lf',
    newLineEnding: 'lf',
    oldMissingNewline: false,
    newMissingNewline: false,
    oldLineCount: Math.max(0, oldStart + oldLines - 1),
    newLineCount: start + now.length - 1,
  };
}

/**
 * History of a line range (`git log -L`): about half of the file's history touches the range,
 * merges come without a diff, the oldest entry adds the lines. Working tree lines are taken as
 * HEAD lines (the backend maps them through a diff).
 */
export function mockLineHistory(
  graph: MockGraph,
  request: LineHistoryRequest,
  cursor: LineHistoryCursor | null,
  limit: number,
  wip: MockWip | null,
): Result<LineHistoryPage> {
  const range = cursor?.range ?? null;
  const path = range?.path ?? request.path;
  const bad = invalidPath(path);
  if (bad) return { error: bad };
  let start = range?.start ?? request.start;
  let end = range?.end ?? request.end;
  if (start < 1 || end < start) {
    return {
      error: invalid(
        `Lines ${String(start)}–${String(end)} are not a valid range.`,
        `Les lignes ${String(start)}–${String(end)} ne forment pas une plage valide.`,
      ),
    };
  }
  if (end - start + 1 > LINE_RANGE_MAX) {
    const lines = String(end - start + 1);
    return {
      error: invalid(
        `The range has ${lines} lines: the history of a line range is limited to ${String(LINE_RANGE_MAX)} lines. Open the file history instead.`,
        `La plage compte ${lines} lignes : l'historique d'une plage est limité à ${String(LINE_RANGE_MAX)} lignes. Ouvrez plutôt l'historique du fichier.`,
      ),
    };
  }
  if (request.rev === null && !range) {
    // Like `in_head` in `repo/inspect.rs`: a file HEAD does not have has no line history.
    const added = wip?.changes('staged').some((c) => c.path === path && c.status === 'added');
    const untracked = wip
      ?.changes('unstaged')
      .some((c) => c.path === path && c.status === 'untracked');
    if (added || untracked || graph.headCommit() === null) {
      return {
        error: invalid(
          `"${path}" is not committed yet: its lines have no history.`,
          `« ${path} » n'est pas encore commité : ses lignes n'ont pas d'historique.`,
        ),
      };
    }
  }
  const head = startCommit(graph, range?.rev ?? request.rev);
  if ('error' in head) return head;
  if (head.ok === null) return { error: notFound('HEAD') };
  if (BINARY.test(path)) {
    return {
      error: invalid(
        `"${path}" is a binary file: it has no lines to follow.`,
        `« ${path} » est un fichier binaire : il n'a pas de lignes à suivre.`,
      ),
    };
  }
  const sha = graph.history.commits[head.ok]?.sha ?? '';
  const local = request.rev === null && !range ? (wip?.worktreeText(path) ?? null) : null;
  const count = lineCount(local ?? mockFileText(path, hash(sha)));
  // A next page follows the range already checked (`check_lines` only runs on the request).
  if (!range && end > count) {
    const where = local === null ? (request.rev ?? 'HEAD') : 'the working tree';
    return {
      error: invalid(
        `"${path}" has only ${String(count)} lines in ${where}.`,
        `« ${path} » n'a que ${String(count)} lignes dans ${where}.`,
      ),
    };
  }
  if (local !== null && !range) {
    // Like `committed_range`: the working tree lines are followed as the HEAD lines they stand for.
    const base = wip?.headText(path) ?? mockFileText(path, hash(sha));
    const mapped = mapToHead(base, local, start, end);
    if (mapped === null) {
      return {
        error: invalid(
          'These lines are not committed yet: they have no history.',
          "Ces lignes ne sont pas encore commitées : elles n'ont pas d'historique.",
        ),
      };
    }
    [start, end] = mapped;
  }
  const items = historyOf(graph, path, head.ok);
  const salt = hash(`${path}:${String(start)}:${String(end)}`);
  const picked = items.filter(
    (item, index) => index === items.length - 1 || (hash(item.entry.sha) ^ salt) % 2 === 0,
  );
  // `git log -L` follows the range: a commit that added or removed lines above it moves it.
  let first = start;
  let last = end;
  const all: LineHistoryEntry[] = picked.map((item, index) => {
    const { entry } = item;
    const origin = index === picked.length - 1;
    const seed = hash(entry.sha);
    const merge = entry.parents.length > 1;
    const slice = (text: string, from: number, to: number) =>
      (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').slice(from - 1, to);
    const now = slice(mockFileText(entry.path, seed), first, last);
    // Lines added (+1) or removed (-1) above the range by this commit, or none.
    const shift = merge || origin ? 0 : (seed % 3) - 1;
    const oldFirst = Math.max(1, first - shift);
    const oldLast = oldFirst + (last - first);
    const old = origin ? null : slice(mockFileText(entry.path, seed + 1), oldFirst, oldLast);
    // Every commit listed changed the range: at least its first line.
    if (old && old.every((line, i) => line === now[i])) old[0] = `${old[0] ?? ''} // before`;
    const diff = merge && !origin ? null : rangeDiff(old, now, first, oldFirst);
    first = oldFirst;
    last = oldLast;
    return {
      sha: entry.sha,
      parents: entry.parents,
      authorName: entry.authorName,
      authorEmail: entry.authorEmail,
      authorTime: entry.authorTime,
      summary: entry.summary,
      path: entry.path,
      oldPath: entry.status === 'renamed' ? entry.oldPath : null,
      status:
        origin && entry.status === 'added'
          ? 'added'
          : entry.status === 'renamed'
            ? 'renamed'
            : 'modified',
      diff,
      origin,
    };
  });
  const skip = cursor?.skip ?? 0;
  const size = Math.max(1, Math.min(limit, PAGE_MAX, Math.floor(100_000 / (end - start + 1))));
  const resolved = { rev: sha, path, start, end };
  return {
    ok: {
      range: resolved,
      entries: all.slice(skip, skip + size),
      next: skip + size < all.length ? { range: resolved, skip: skip + size } : null,
    },
  };
}

/** Content of `path` in a commit of its mock history (`seed` varies it between versions). */
export function mockFileText(path: string, seed: number): string {
  const lines = path.includes('huge') ? MOCK_HUGE_FILE_LINES : 80 + (hash(path) % 120);
  const name = basename(path).replace(/\W+/g, '_');
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const v = (hash(`${path}:${String(i)}`) + (i % 9 === seed % 9 ? seed : 0)) % 1000;
    if (i % 12 === 0) out.push(`// ${name}: section ${String(i / 12)}`);
    else if (i % 12 === 1) out.push(`export function ${name}${String(i)}(input: number) {`);
    else if (i % 12 === 10) out.push('}');
    else if (i % 12 === 11) out.push('');
    else out.push(`  const value${String(i)} = input * ${String(v)}; // step ${String(i % 12)}`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * The change a commit of a mock file history made to the file, for `fileDiff` on paths the
 * showcase commit does not list.
 */
export function historyFileChange(
  sha: string,
  path: string,
  oldPath: string | null,
): MockFileChange {
  const seed = hash(sha);
  return {
    path,
    ...(oldPath && oldPath !== path ? { oldPath, similarity: 92 } : {}),
    status: oldPath && oldPath !== path ? 'renamed' : 'modified',
    oldMode: 'regular',
    newMode: 'regular',
    old: mockFileText(path, seed + 1),
    new: mockFileText(path, seed),
  };
}

function commitOf(
  graph: MockGraph,
  item: HistoryItem,
  items: readonly HistoryItem[],
  index: number,
): BlameCommit {
  const commit = graph.history.commits[item.commit] as MockCommit;
  const older = items[index + 1];
  return {
    sha: commit.sha,
    authorName: commit.authorName,
    authorEmail: commit.authorEmail,
    authorTime: commit.authorTime,
    summary: commit.summary,
    path: item.entry.path,
    previous: older
      ? { sha: graph.history.commits[older.commit]?.sha ?? '', path: older.entry.path }
      : null,
    uncommitted: false,
  };
}

/** Lines attributed in runs of 1–12 to the file's commits, older ones more often. */
function attribute(
  lineCount: number,
  commits: number,
  salt: number,
  uncommitted: number | null,
): BlameChunk[] {
  const chunks: BlameChunk[] = [];
  let line = 0;
  let n = salt;
  while (line < lineCount) {
    n = hash(String(n));
    const count = Math.min(lineCount - line, 1 + (n % 12));
    // Squared: older commits (low indices) own more lines, like in a real file.
    const r = ((n >>> 8) % 1000) / 1000;
    let commit = Math.min(commits - 1, Math.floor(r * r * commits));
    if (uncommitted !== null && (n >>> 4) % 17 === 0) commit = uncommitted;
    const previous = chunks[chunks.length - 1];
    if (previous?.commit === commit) previous.count += count;
    else chunks.push({ start: line, count, commit, sourceStart: line });
    line += count;
  }
  return chunks;
}

export function mockBlame(
  graph: MockGraph,
  path: string,
  rev: string | null,
  wip: MockWip | null,
): Result<Blame> {
  const bad = invalidPath(path);
  if (bad) return { error: bad };
  const start = startCommit(graph, rev);
  if ('error' in start) return start;
  const sha = rev === null ? null : (graph.history.commits[start.ok ?? -1]?.sha ?? null);
  const blame = (content: BlameContent): Result<Blame> => ({ ok: { path, rev: sha, content } });
  if (rev === null) {
    const added = wip?.changes('staged').some((c) => c.path === path && c.status === 'added');
    const untracked = wip
      ?.changes('unstaged')
      .some((c) => c.path === path && c.status === 'untracked');
    if (added || untracked || start.ok === null) return blame({ kind: 'notCommitted' });
  }
  if (start.ok === null) return { error: notFound('HEAD') };
  if (BINARY.test(path)) return blame({ kind: 'binary', size: 2_048 + (hash(path) % 50_000) });
  const items = historyOf(graph, path, start.ok);
  // A file no commit lists: attributed to the blamed commit.
  if (items.length === 0) {
    const commit = graph.history.commits[start.ok] as MockCommit;
    items.push({
      commit: start.ok,
      entry: {
        sha: commit.sha,
        parents: [],
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
        authorTime: commit.authorTime,
        summary: commit.summary,
        path,
        oldPath: null,
        status: 'added',
        similarity: null,
      },
    });
  }
  const local = rev === null ? (wip?.worktreeText(path) ?? null) : null;
  const text = local ?? mockFileText(path, hash(sha ?? 'HEAD'));
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  const commits = items.map((item, index) => commitOf(graph, item, items, index)).reverse();
  const dirty =
    rev === null &&
    wip?.changes('unstaged').some((c) => c.path === path && c.status === 'modified');
  if (dirty) {
    const head = commits[commits.length - 1];
    commits.push({
      sha: NULL_SHA,
      authorName: 'External file (--contents)',
      authorEmail: 'external.file',
      authorTime: graph.history.commits[start.ok]?.commitTime ?? 0,
      summary: `Version of ${path} from standard input`,
      path,
      previous: head ? { sha: graph.history.commits[start.ok]?.sha ?? '', path } : null,
      uncommitted: true,
    });
  }
  // Oldest first, so the attribution favours the low (older) indices.
  const chunks = attribute(
    lines.length,
    items.length,
    hash(path),
    dirty ? commits.length - 1 : null,
  );
  return blame({ kind: 'text', lines, encoding: 'utf8', commits, chunks });
}

const REFLOG_PATTERNS = [
  (summary: string) => `commit: ${summary}`,
  (summary: string) => `commit: ${summary}`,
  (summary: string) => `commit (amend): ${summary}`,
  () => 'pull: Fast-forward',
  () => 'rebase (finish): returning to refs/heads/main',
  () => 'merge origin/main: Fast-forward',
];

/** Reflog of `reference`, derived from the first-parent history of its tip. */
export function mockReflog(
  graph: MockGraph,
  reference: string,
  start: number,
  limit: number,
): Result<ReflogPage> {
  const known =
    reference === 'HEAD' ||
    reference.startsWith('refs/heads/') ||
    reference.startsWith('refs/remotes/');
  if (!known || reference.includes('..') || /\s/.test(reference)) {
    return {
      error: invalid(
        `"${reference}" has no reflog yaggui can show.`,
        `« ${reference} » n'a pas de reflog que yaggui puisse afficher.`,
      ),
    };
  }
  const { history } = graph;
  const tip = reference === 'HEAD' ? graph.headCommit() : graph.resolve(reference);
  if (tip === null) {
    if (reference === 'HEAD') return { ok: { reference, entries: [], total: 0 } };
    return { error: notFound(reference) };
  }
  const chain: number[] = [];
  for (let c: number | undefined = tip; c !== undefined && chain.length < 60;) {
    chain.push(c);
    c = history.commits[c]?.parents[0];
  }
  const other = history.local.find((b) => b.commit !== tip)?.name ?? 'feat/other';
  const current = history.head.kind === 'branch' ? history.head.name : 'main';
  const entries: Omit<ReflogEntry, 'index'>[] = [];
  chain.forEach((c, i) => {
    const commit = history.commits[c] as MockCommit;
    const old = chain[i + 1];
    const base = {
      newSha: commit.sha,
      oldSha: old === undefined ? null : (history.commits[old]?.sha ?? null),
      committerName: commit.authorName,
      time: commit.commitTime,
      exists: true,
    };
    const h = hash(commit.sha);
    if (reference === 'HEAD' && i === 1) {
      // An undone commit: the classic "lost work" the reflog brings back.
      entries.push({
        ...base,
        newSha: mockSha(0x5eed, c),
        message: 'commit: wip: experiment',
        exists: false,
        time: base.time + 30,
      });
      entries.push({ ...base, message: `reset: moving to HEAD~1`, time: base.time + 60 });
    }
    if (reference === 'HEAD' && i > 0 && h % 5 === 0) {
      entries.push({
        ...base,
        oldSha: base.newSha,
        message: `checkout: moving from ${other} to ${current}`,
        time: base.time + 20,
      });
      entries.push({
        ...base,
        oldSha: base.newSha,
        message: `checkout: moving from ${current} to ${other}`,
        time: base.time + 10,
      });
    }
    const pattern = REFLOG_PATTERNS[h % REFLOG_PATTERNS.length] ?? REFLOG_PATTERNS[0];
    entries.push({ ...base, message: pattern ? pattern(commit.summary) : commit.summary });
  });
  const last = entries[entries.length - 1];
  if (last && reference !== 'HEAD') {
    last.message = 'branch: Created from HEAD';
    last.oldSha = null;
  }
  const page = entries
    .slice(start, start + Math.min(limit, PAGE_MAX))
    .map((entry, i) => ({ ...entry, index: start + i }));
  return { ok: { reference, entries: page, total: entries.length } };
}
