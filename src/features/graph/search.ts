import type { CommitSearch, SearchChunk } from '../../ipc';

export interface SearchProgress {
  /** Graph version the rows refer to. */
  version: number;
  /** Matching rows found so far, ascending. */
  matches: number[];
  /** Rows scanned so far. */
  scanned: number;
  totalRows: number;
  done: boolean;
}

/** Cancelling a search is just not asking for the next chunk (contract of `searchCommits`). */
export interface SearchToken {
  cancelled: boolean;
}

export function emptySearch(): CommitSearch {
  return { text: null, author: null, path: null, since: null, until: null };
}

/** Trims the criteria; empty strings become `null` (not a criterion). */
export function normalizeSearch(query: CommitSearch): CommitSearch {
  const clean = (value: string | null) => {
    const trimmed = value?.trim() ?? '';
    return trimmed === '' ? null : trimmed;
  };
  return {
    text: clean(query.text),
    author: clean(query.author),
    path: clean(query.path),
    since: query.since,
    until: query.until,
  };
}

export function isEmptySearch(query: CommitSearch): boolean {
  const q = normalizeSearch(query);
  return (
    q.text === null && q.author === null && q.path === null && q.since === null && q.until === null
  );
}

/**
 * Runs a chunked search to the end, reporting progress after each chunk. Restarts from row 0
 * when the graph version changes under it (the row indices would be wrong), at most
 * `maxRestarts` times. Resolves with the final progress, or `null` when cancelled.
 */
export async function runSearch(
  fetchChunk: (fromRow: number) => Promise<SearchChunk>,
  onProgress: (progress: SearchProgress) => void,
  token: SearchToken,
  maxRestarts = 3,
): Promise<SearchProgress | null> {
  let restarts = 0;
  let version: number | null = null;
  let matches: number[] = [];
  let from = 0;
  for (;;) {
    const chunk = await fetchChunk(from);
    if (token.cancelled) return null;
    if (version !== null && chunk.version !== version) {
      if (restarts >= maxRestarts) throw new Error('The graph keeps changing during the search');
      restarts += 1;
      version = null;
      matches = [];
      from = 0;
      continue;
    }
    version = chunk.version;
    matches = matches.concat(chunk.matches);
    const done = chunk.nextRow === null;
    const progress: SearchProgress = {
      version,
      matches,
      scanned: done ? chunk.totalRows : (chunk.nextRow ?? chunk.totalRows),
      totalRows: chunk.totalRows,
      done,
    };
    onProgress(progress);
    if (done) return progress;
    from = chunk.nextRow ?? chunk.totalRows;
  }
}

/** Index in `matches` of the next (or previous) match after `row`, wrapping around. */
export function nextMatch(
  matches: readonly number[],
  row: number | null,
  direction: 1 | -1,
): number | null {
  if (matches.length === 0) return null;
  if (row === null) return direction === 1 ? 0 : matches.length - 1;
  // Binary search for the first match > row (or < row going up).
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((matches[mid] ?? 0) <= row) lo = mid + 1;
    else hi = mid;
  }
  if (direction === 1) return lo < matches.length ? lo : 0;
  const before = matches[lo - 1] === row ? lo - 2 : lo - 1;
  return before >= 0 ? before : matches.length - 1;
}

/** Position of `row` in `matches`, or -1. */
export function matchIndex(matches: readonly number[], row: number | null): number {
  if (row === null) return -1;
  let lo = 0;
  let hi = matches.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = matches[mid] ?? 0;
    if (value === row) return mid;
    if (value < row) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
