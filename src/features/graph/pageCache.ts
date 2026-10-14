import {
  GRAPH_PAGE_SIZE,
  SIGNATURE_GPG,
  SIGNATURE_SSH,
  SIGNATURE_UNKNOWN,
  SIGNATURE_X509,
  type GraphPage,
  type GraphWip,
  type RefLabel,
  type SignatureKind,
} from '../../ipc';

/** One commit row, built once per loaded page so memoized row components stay stable. */
export interface GraphRow {
  row: number;
  sha: string;
  parents: string[];
  summary: string;
  authorName: string;
  authorEmail: string;
  authorTime: number | null;
  commitTime: number | null;
  lane: number;
  color: number;
  refs: RefLabel[];
  /** Kind of the signature in the commit header, not verified. */
  signature: SignatureKind | null;
}

interface CachedPage {
  index: number;
  start: number;
  rows: GraphRow[];
  /** Relative to the page, as in `GraphPage`. */
  edgeOffsets: number[];
  edges: number[];
  laneCount: number;
}

/** Edges of one row: `edges[4 * from .. 4 * to]`, by groups of `[fromLane, toLane, color, kind]`. */
export interface RowEdges {
  edges: readonly number[];
  from: number;
  to: number;
}

export type PageFetcher = (start: number, limit: number) => Promise<GraphPage>;

export interface PageCacheOptions {
  /** Upper bound of the pages kept in memory (pages around the viewport are never evicted). */
  maxPages?: number;
  pageSize?: number;
  /** Rows loaded ahead of and behind the requested range. */
  prefetchRows?: number;
  /** Delay before a page that failed is requested again. */
  retryDelayMs?: number;
  /** A page arrived or the cache was reset. */
  onChange?: () => void;
  /** A page came back with another graph version: the cached pages are stale. */
  onVersionMismatch?: (page: GraphPage) => void;
  onError?: (error: unknown) => void;
  now?: () => number;
}

const SIGNATURE_KINDS: ReadonlyMap<number, SignatureKind> = new Map([
  [SIGNATURE_GPG, 'gpg'],
  [SIGNATURE_SSH, 'ssh'],
  [SIGNATURE_X509, 'x509'],
  [SIGNATURE_UNKNOWN, 'unknown'],
]);

/** Kind of a `GraphPage.signatures` code, `null` when unsigned. */
export function signatureOf(code: number | undefined): SignatureKind | null {
  return code === undefined ? null : (SIGNATURE_KINDS.get(code) ?? null);
}

export function toRows(page: GraphPage): GraphRow[] {
  const refsByRow = new Map<number, RefLabel[]>();
  for (const ref of page.refs) {
    const list = refsByRow.get(ref.row);
    if (list) list.push(ref.label);
    else refsByRow.set(ref.row, [ref.label]);
  }
  return page.shas.map((sha, k) => {
    const row = page.start + k;
    return {
      row,
      sha,
      parents: page.parents[k] ?? [],
      summary: page.summaries[k] ?? '',
      authorName: page.authorNames[k] ?? '',
      authorEmail: page.authorEmails[k] ?? '',
      authorTime: page.authorTimes[k] ?? null,
      commitTime: page.commitTimes[k] ?? null,
      lane: page.lanes[k] ?? 0,
      color: page.colors[k] ?? 0,
      refs: refsByRow.get(row) ?? [],
      signature: signatureOf(page.signatures[k]),
    };
  });
}

/**
 * Pages of one graph version, loaded on demand around the viewport and kept in a bounded LRU.
 * Rows of another version are never mixed in: a page with a new version is reported through
 * `onVersionMismatch` and dropped.
 */
export class GraphPageCache {
  version: number | null = null;
  /** Rows of the graph; while `totalExact` is false (history walk running), a lower bound. */
  totalRows = 0;
  totalExact = true;
  wip: GraphWip | null = null;
  /** Widest lane count seen on the loaded pages (sizes the auto graph column). */
  laneCount = 0;

  private pages = new Map<number, CachedPage>();
  private inflight = new Set<number>();
  private failedAt = new Map<number, number>();
  /** Pages of the last `ensure` call, never evicted. */
  private wanted = new Set<number>();
  /** Bumped by `reset` so answers to older requests are ignored. */
  private generation = 0;
  private readonly maxPages: number;
  private readonly pageSize: number;
  private readonly prefetchRows: number;
  private readonly retryDelayMs: number;
  private readonly now: () => number;

  constructor(
    private readonly fetchPage: PageFetcher,
    private readonly options: PageCacheOptions = {},
  ) {
    this.maxPages = options.maxPages ?? 24;
    this.pageSize = options.pageSize ?? GRAPH_PAGE_SIZE;
    this.prefetchRows = options.prefetchRows ?? Math.floor(this.pageSize / 2);
    this.retryDelayMs = options.retryDelayMs ?? 2000;
    this.now = options.now ?? (() => Date.now());
  }

  get loadedPages(): number {
    return this.pages.size;
  }

  get pending(): number {
    return this.inflight.size;
  }

  /** Forgets every page; the next `insert` sets the version. */
  reset(): void {
    this.generation += 1;
    this.pages.clear();
    this.inflight.clear();
    this.failedAt.clear();
    this.wanted.clear();
    this.version = null;
    this.totalRows = 0;
    this.totalExact = true;
    this.wip = null;
    this.laneCount = 0;
    this.options.onChange?.();
  }

  /**
   * The backend's history walk got further (`graphProgress`): rows of a version only ever
   * grow, so pages already loaded stay. Returns `false` for another version.
   */
  progress(version: number, totalRows: number, exact: boolean): boolean {
    if (version !== this.version) return false;
    this.totalRows = Math.max(this.totalRows, totalRows);
    this.totalExact ||= exact;
    this.options.onChange?.();
    return true;
  }

  /** Adds a fetched page. Returns `false` (and keeps nothing) when its version differs. */
  insert(page: GraphPage): boolean {
    if (this.version !== null && page.version !== this.version) {
      this.options.onVersionMismatch?.(page);
      return false;
    }
    const same = this.version === page.version;
    this.version = page.version;
    // Answers can arrive out of order: a lower bound never shrinks the total.
    this.totalRows = same ? Math.max(this.totalRows, page.totalRows) : page.totalRows;
    this.totalExact = page.totalExact || (same && this.totalExact);
    // HEAD's row is known once the walk reached it, then on every page.
    this.wip = page.wip ?? (same ? this.wip : null);
    if (page.shas.length > 0) {
      const index = Math.floor(page.start / this.pageSize);
      this.pages.delete(index);
      this.pages.set(index, {
        index,
        start: page.start,
        rows: toRows(page),
        edgeOffsets: page.edgeOffsets,
        edges: page.edges,
        laneCount: page.laneCount,
      });
      this.laneCount = Math.max(this.laneCount, page.laneCount);
      this.evict();
    }
    this.failedAt.delete(Math.floor(page.start / this.pageSize));
    this.options.onChange?.();
    return true;
  }

  private pageOf(row: number): CachedPage | undefined {
    return this.pages.get(Math.floor(row / this.pageSize));
  }

  row(row: number): GraphRow | undefined {
    const page = this.pageOf(row);
    return page?.rows[row - page.start];
  }

  edgesOf(row: number): RowEdges | undefined {
    const page = this.pageOf(row);
    if (!page) return undefined;
    const k = row - page.start;
    const from = page.edgeOffsets[k];
    const to = page.edgeOffsets[k + 1];
    if (from === undefined || to === undefined) return undefined;
    return { edges: page.edges, from, to };
  }

  has(row: number): boolean {
    return this.row(row) !== undefined;
  }

  /**
   * Makes sure rows `first..last` (and the prefetch margin) are loaded or loading, marks their
   * pages as recently used and evicts the least recently used pages beyond the bound.
   */
  ensure(first: number, last: number): void {
    if (this.totalRows <= 0 && this.version !== null) return;
    const maxRow = this.version === null ? last : this.totalRows - 1;
    const from = Math.max(0, first - this.prefetchRows);
    const to = Math.min(maxRow, last + this.prefetchRows);
    if (to < from) return;
    const firstPage = Math.floor(from / this.pageSize);
    const lastPage = Math.floor(to / this.pageSize);
    const wanted = new Set<number>();
    for (let index = firstPage; index <= lastPage; index++) {
      wanted.add(index);
      const page = this.pages.get(index);
      if (page) {
        // Re-insert: Map iteration order is the LRU order.
        this.pages.delete(index);
        this.pages.set(index, page);
      } else {
        this.request(index);
      }
    }
    this.wanted = wanted;
    this.evict();
  }

  private evict(): void {
    if (this.pages.size <= this.maxPages) return;
    for (const index of this.pages.keys()) {
      if (this.pages.size <= this.maxPages) break;
      if (!this.wanted.has(index)) this.pages.delete(index);
    }
  }

  private request(index: number): void {
    if (this.inflight.has(index)) return;
    const failed = this.failedAt.get(index);
    if (failed !== undefined && this.now() - failed < this.retryDelayMs) return;
    const generation = this.generation;
    this.inflight.add(index);
    this.fetchPage(index * this.pageSize, this.pageSize).then(
      (page) => {
        if (generation !== this.generation) return;
        this.inflight.delete(index);
        this.insert(page);
      },
      (error: unknown) => {
        if (generation !== this.generation) return;
        this.inflight.delete(index);
        this.failedAt.set(index, this.now());
        this.options.onError?.(error);
      },
    );
  }
}
