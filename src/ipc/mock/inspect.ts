import type {
  Blame,
  BlameChunk,
  BlameCommit,
  BlameContent,
  FileHistoryCursor,
  FileHistoryEntry,
  FileHistoryPage,
  YagguiError,
  ReflogEntry,
  ReflogPage,
} from '../bindings';
import type { MockCommit, MockGraph } from '../mockGraph';
import { mockSha } from '../mockGraph';
import type { MockFileChange } from './diffData';
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
