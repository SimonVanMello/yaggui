import { useSyncExternalStore } from 'react';

import {
  GRAPH_PAGE_SIZE,
  YagguiIpcError,
  ipc,
  unwrap,
  type CommitSearch,
  type GraphPage,
  type GraphProgress,
  type YagguiError,
} from '../../ipc';
import { useGraphNavigation, type RevealRequest } from '../repo/graphNavigation';
import { useRepoSessions } from '../repo/repoSessions';
import { GraphPageCache } from './pageCache';
import {
  EMPTY_SELECTION,
  applyOrder,
  clickSelection,
  graphOrder,
  relocate,
  selectRange,
  singleSelection,
  type ClickModifiers,
  type PickedCommit,
  type RowSelectionState,
} from './selectionModel';
import {
  emptySearch,
  isEmptySearch,
  matchIndex,
  nextMatch,
  normalizeSearch,
  runSearch,
  type SearchToken,
} from './search';

export type GraphSelection = { kind: 'wip' } | { kind: 'commit'; sha: string; row: number | null };

export interface SearchState {
  open: boolean;
  query: CommitSearch;
  /** Matching rows found so far, ascending. */
  matches: readonly number[];
  running: boolean;
  scanned: number;
  totalRows: number;
  /** Index in `matches` of the match the user is on, -1 before the first. */
  active: number;
  error: YagguiError | null;
}

export interface ScrollRequest {
  row: number;
  align: 'start' | 'center' | 'auto';
  /** Distinguishes two requests for the same row. */
  id: number;
}

const SEARCH_DEBOUNCE_MS = 180;

export function asYagguiError(error: unknown): YagguiError {
  if (error instanceof YagguiIpcError) return error.error;
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: 'internal',
    message: { en: message, fr: message },
    action: null,
    detail: null,
    payload: null,
  };
}

/**
 * Everything the graph view needs to survive a tab switch (only the active tab is mounted):
 * loaded pages, selection, scroll position and search live here, outside React. Components
 * subscribe through `useGraphSource`.
 */
export class GraphSource {
  readonly cache: GraphPageCache;
  selection: GraphSelection | null = null;
  /** Every selected commit (⌘ / ⇧-click); `selection` is the one the detail panel shows. */
  picks: RowSelectionState = EMPTY_SELECTION;
  /** Rows of the selection, for the row components. */
  pickedRows: ReadonlySet<number> = new Set();
  search: SearchState = {
    open: false,
    query: emptySearch(),
    matches: [],
    running: false,
    scanned: 0,
    totalRows: 0,
    active: -1,
    error: null,
  };
  loadError: YagguiError | null = null;
  /** Last scroll offset, restored when the tab is shown again. */
  scrollTop = 0;
  /** Commit at the top of the viewport: the anchor kept across a graph reload. */
  topSha: string | null = null;
  scrollRequest: ScrollRequest | null = null;
  /** Bumped on each change; the snapshot of `useSyncExternalStore`. */
  version = 0;

  private listeners = new Set<() => void>();
  private stale = false;
  private refreshId = 0;
  private scrollId = 0;
  private pendingSelectRow: number | null = null;
  private pendingRange: { anchor: number; hit: PickedCommit; base: boolean } | null = null;
  private searchToken: SearchToken | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private revealFirstMatch = false;
  private handledReveal = 0;
  private pendingReveal: RevealRequest | null = null;
  private readonly unsubscribeNavigation: () => void;

  constructor(readonly repoId: number) {
    this.cache = new GraphPageCache(
      async (start, limit) => unwrap(ipc.commands.graphPage(repoId, start, limit)),
      {
        onChange: () => {
          this.resolvePendingSelect();
          this.resolvePendingRange();
          if (this.pendingReveal) this.applyReveal(this.pendingReveal);
          this.notify();
        },
        onVersionMismatch: () => {
          void this.refresh();
        },
        onError: (error) => {
          this.loadError = asYagguiError(error);
          this.notify();
        },
      },
    );
    // Refs sidebar, branch selector… ask the graph to show a commit (see graphNavigation.ts).
    const onReveal = (request: RevealRequest | undefined) => {
      if (!request || request.seq <= this.handledReveal) return;
      this.handledReveal = request.seq;
      this.applyReveal(request);
    };
    onReveal(useGraphNavigation.getState().reveal[repoId]);
    this.unsubscribeNavigation = useGraphNavigation.subscribe((state) => {
      onReveal(state.reveal[repoId]);
    });
  }

  dispose(): void {
    this.unsubscribeNavigation();
    useGraphNavigation.getState().clear(this.repoId);
  }

  /** Row known for this layout version: direct. Otherwise `graph_index_of`. Waits for page 0. */
  private applyReveal(request: RevealRequest): void {
    if (this.cache.totalRows === 0) {
      this.pendingReveal = request;
      return;
    }
    this.pendingReveal = null;
    if (request.row !== null && request.version === this.cache.version) {
      this.selectRow(request.row, 'center');
      return;
    }
    void this.revealSha(request.sha);
  }

  private async revealSha(sha: string): Promise<void> {
    const row = await this.locate(sha);
    if (row !== null) this.selectRow(row, 'center');
    else {
      // Not in the graph (e.g. unreachable): keep the selection without a row.
      this.pendingSelectRow = null;
      this.selection = { kind: 'commit', sha, row: null };
      this.notify();
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.stale) {
      this.stale = false;
      void this.refresh();
    }
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): number => this.version;

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** Loads the pages around a row range (and keeps them from being evicted). */
  ensure(first: number, last: number): void {
    this.cache.ensure(first, last);
  }

  /** Drops the loading error and asks for the pages again. */
  retry(): void {
    this.loadError = null;
    this.cache.reset();
    this.notify();
  }

  // --- Reload on refsChanged -------------------------------------------------------------

  /**
   * Progress of the backend's history walk: more rows, then the exact count (page 0 is fetched
   * again then, for HEAD's row). A dropped version (`stale`) or another one reloads the graph.
   */
  walkProgress(progress: Omit<GraphProgress, 'repoId'>): void {
    if (this.cache.version === null) return;
    if (progress.stale || progress.version !== this.cache.version) {
      this.invalidate();
      return;
    }
    this.cache.progress(progress.version, progress.totalRows, progress.exact);
    if (progress.exact) this.invalidate();
  }

  /** Refs changed: reload now when shown, otherwise at the next mount. */
  invalidate(): void {
    if (this.listeners.size === 0) this.stale = true;
    else void this.refresh();
  }

  /**
   * Refetches page 0. If the graph version moved, every page is dropped and the view is put back
   * on the same commit (top of the viewport and selection are located in the new graph).
   */
  async refresh(): Promise<void> {
    const id = ++this.refreshId;
    try {
      const page: GraphPage = await unwrap(ipc.commands.graphPage(this.repoId, 0, GRAPH_PAGE_SIZE));
      if (id !== this.refreshId) return;
      if (page.version === this.cache.version) {
        this.cache.insert(page);
        return;
      }
      const selectedSha = this.selection?.kind === 'commit' ? this.selection.sha : null;
      const [anchor, selected] = await Promise.all([
        this.locate(this.topSha),
        selectedSha === this.topSha ? undefined : this.locate(selectedSha),
      ]);
      if (id !== this.refreshId) return;
      this.cache.reset();
      this.cache.insert(page);
      this.loadError = null;
      if (this.selection?.kind === 'commit') {
        const row = (selectedSha === this.topSha ? anchor : selected) ?? null;
        this.selection = { kind: 'commit', sha: this.selection.sha, row };
      }
      if (this.picks.picked.size > 1) {
        const shas = [...this.picks.picked.keys()];
        const located = await Promise.all(shas.map((sha) => this.locate(sha)));
        if (id !== this.refreshId) return;
        this.setPicks(
          relocate(this.picks, new Map(shas.map((sha, i) => [sha, located[i] ?? null]))),
        );
      } else if (this.selection?.kind === 'commit' && this.selection.row !== null) {
        this.setPicks(singleSelection({ sha: this.selection.sha, row: this.selection.row }));
      } else {
        this.setPicks(EMPTY_SELECTION);
      }
      if (anchor !== null) this.requestScroll(anchor, 'start');
      else if (this.scrollTop > 0) this.requestScroll(0, 'start');
      if (!isEmptySearch(this.search.query)) this.runQuery();
      this.notify();
    } catch (error) {
      if (id !== this.refreshId) return;
      this.loadError = asYagguiError(error);
      this.notify();
    }
  }

  private async locate(sha: string | null): Promise<number | null> {
    if (sha === null) return null;
    try {
      return (await unwrap(ipc.commands.graphIndexOf(this.repoId, sha))).row;
    } catch {
      return null;
    }
  }

  // --- Selection -------------------------------------------------------------------------

  private requestScroll(row: number, align: ScrollRequest['align']): void {
    this.scrollId += 1;
    this.scrollRequest = { row, align, id: this.scrollId };
  }

  private setPicks(picks: RowSelectionState): void {
    this.picks = picks;
    this.pickedRows = new Set(picks.picked.values());
  }

  selectWip(): void {
    this.pendingSelectRow = null;
    this.pendingRange = null;
    this.setPicks(EMPTY_SELECTION);
    this.selection = { kind: 'wip' };
    useGraphNavigation.getState().selectCommit(this.repoId, null);
    this.notify();
  }

  selectCommit(sha: string, row: number): void {
    this.pendingSelectRow = null;
    this.pendingRange = null;
    this.setPicks(singleSelection({ sha, row }));
    this.selection = { kind: 'commit', sha, row };
    useGraphNavigation.getState().selectCommit(this.repoId, sha);
    this.notify();
  }

  clearSelection(): void {
    this.selection = null;
    this.pendingSelectRow = null;
    this.pendingRange = null;
    this.setPicks(EMPTY_SELECTION);
    useGraphNavigation.getState().selectCommit(this.repoId, null);
    this.notify();
  }

  /** Click with ⌘ / Ctrl and / or ⇧ held: builds the multi-selection (F-143). */
  pickRow(row: number, modifiers: ClickModifiers): void {
    const data = this.cache.row(row);
    if (!data) return;
    const hit = { sha: data.sha, row };
    if (modifiers.range && this.picks.anchor !== null) {
      this.applyRange(this.picks.anchor, hit, modifiers.toggle);
      return;
    }
    const { state } = clickSelection(this.picks, hit, modifiers, (r) => this.cache.row(r)?.sha);
    this.applyPicks(state);
  }

  /** ⇧↑ / ⇧↓: extends the range from the anchor to the row next to the primary one. */
  extendSelection(delta: number): void {
    const from = this.picks.primary?.row ?? this.selectedRow();
    const anchor = this.picks.anchor ?? from;
    if (from === null || anchor === null) return;
    const target = Math.min(this.cache.totalRows - 1, Math.max(0, from + delta));
    const data = this.cache.row(target);
    this.requestScroll(target, 'auto');
    if (!data) {
      this.cache.ensure(target, target);
      return;
    }
    this.applyRange(anchor, { sha: data.sha, row: target }, false);
  }

  private applyRange(anchor: number, hit: PickedCommit, keep: boolean): void {
    const result = selectRange(
      anchor,
      hit,
      (r) => this.cache.row(r)?.sha,
      keep ? this.picks.picked : null,
    );
    if (result.missing) {
      this.pendingRange = { anchor, hit, base: keep };
      this.cache.ensure(result.missing.from, result.missing.to);
    } else {
      this.pendingRange = null;
    }
    this.applyPicks(result.state);
  }

  private resolvePendingRange(): void {
    const pending = this.pendingRange;
    if (!pending) return;
    this.applyRange(pending.anchor, pending.hit, pending.base);
  }

  private applyPicks(state: RowSelectionState): void {
    this.pendingSelectRow = null;
    this.setPicks(state);
    const { primary } = state;
    if (primary) {
      this.selection = { kind: 'commit', sha: primary.sha, row: primary.row };
      useGraphNavigation.getState().selectCommit(this.repoId, primary.sha);
    } else {
      this.selection = null;
      useGraphNavigation.getState().selectCommit(this.repoId, null);
    }
    this.notify();
  }

  /** Selected commits in graph order, newest first (one entry for a plain selection). */
  selectedCommits(): PickedCommit[] {
    return graphOrder(this.picks);
  }

  /** The order a cherry-pick applies them in. */
  commitsToApply(): PickedCommit[] {
    return applyOrder(this.picks);
  }

  /** Esc: back to the primary commit only. */
  collapseSelection(): boolean {
    if (this.picks.picked.size <= 1) return false;
    const primary = this.picks.primary;
    if (primary) this.selectCommit(primary.sha, primary.row);
    return true;
  }

  /** Selects a row and scrolls to it; rows not loaded yet are selected once they arrive. */
  selectRow(row: number, align: ScrollRequest['align'] = 'auto'): void {
    const total = this.cache.totalRows;
    if (total <= 0) return;
    const target = Math.min(total - 1, Math.max(0, row));
    this.requestScroll(target, align);
    const data = this.cache.row(target);
    if (data) this.selectCommit(data.sha, target);
    else {
      this.pendingSelectRow = target;
      this.notify();
    }
  }

  private resolvePendingSelect(): void {
    if (this.pendingSelectRow === null) return;
    const data = this.cache.row(this.pendingSelectRow);
    if (data) this.selectCommit(data.sha, this.pendingSelectRow);
  }

  private isSelected(sha: string): boolean {
    return this.selection?.kind === 'commit' && this.selection.sha === sha;
  }

  selectedRow(): number | null {
    return this.selection?.kind === 'commit' ? this.selection.row : null;
  }

  /** `⌘⇧H`: selects and centers the commit HEAD points to. */
  async goToHead(): Promise<void> {
    const headRow = this.cache.wip?.headRow;
    if (headRow !== undefined) {
      this.selectRow(headRow, 'center');
      return;
    }
    const row = await this.locate('HEAD');
    if (row !== null) this.selectRow(row, 'center');
  }

  async goToSha(sha: string): Promise<void> {
    const row = await this.locate(sha);
    if (row !== null) this.selectRow(row, 'center');
  }

  /**
   * Selects a commit a write just created (a reword): the panel shows it at once, its row is
   * located once the graph has the new layout, which the loaded pages may not have yet.
   */
  async followSha(sha: string): Promise<void> {
    this.pendingSelectRow = null;
    this.pendingRange = null;
    this.setPicks(EMPTY_SELECTION);
    this.selection = { kind: 'commit', sha, row: null };
    useGraphNavigation.getState().selectCommit(this.repoId, sha);
    this.notify();
    await this.refresh();
    const row = await this.locate(sha);
    // Another selection may have been made meanwhile (TS keeps the narrowing across `await`).
    if (row === null || !this.isSelected(sha)) return;
    // Still the old layout: the refresh in flight relocates the selection by its SHA.
    const loaded = this.cache.row(row);
    if (loaded && loaded.sha !== sha) return;
    this.selectRow(row, 'center');
  }

  // --- Search ----------------------------------------------------------------------------

  openSearch(): void {
    this.search = { ...this.search, open: true };
    this.notify();
  }

  closeSearch(): void {
    this.cancelSearch();
    this.search = { ...this.search, open: false, running: false };
    this.notify();
  }

  setQuery(query: CommitSearch): void {
    this.search = { ...this.search, query };
    this.cancelSearch();
    clearTimeout(this.searchTimer);
    this.notify();
    this.searchTimer = setTimeout(() => {
      this.runQuery();
    }, SEARCH_DEBOUNCE_MS);
  }

  private cancelSearch(): void {
    clearTimeout(this.searchTimer);
    if (this.searchToken) this.searchToken.cancelled = true;
    this.searchToken = null;
  }

  private runQuery(): void {
    this.cancelSearch();
    const query = normalizeSearch(this.search.query);
    this.revealFirstMatch = true;
    this.search = {
      ...this.search,
      matches: [],
      active: -1,
      scanned: 0,
      error: null,
      running: !isEmptySearch(query),
    };
    if (isEmptySearch(query)) {
      this.notify();
      return;
    }
    const token: SearchToken = { cancelled: false };
    this.searchToken = token;
    this.notify();
    runSearch(
      (from) => unwrap(ipc.commands.searchCommits(this.repoId, query, from)),
      (progress) => {
        if (token.cancelled) return;
        let active = this.search.active;
        if (active === -1 && this.revealFirstMatch && progress.matches.length > 0) {
          // First result: the first match at or after the selection, else the first one.
          const from = this.selectedRow();
          active = nextMatch(progress.matches, from === null ? null : from - 1, 1) ?? 0;
          this.revealFirstMatch = false;
          const row = progress.matches[active];
          if (row !== undefined) this.selectRow(row, 'center');
        }
        this.search = {
          ...this.search,
          matches: progress.matches,
          scanned: progress.scanned,
          totalRows: progress.totalRows,
          running: !progress.done,
          active,
        };
        this.notify();
      },
      token,
    ).catch((error: unknown) => {
      if (token.cancelled) return;
      this.search = { ...this.search, running: false, error: asYagguiError(error) };
      this.notify();
    });
  }

  /** `↵` / `⇧↵`: goes to the next or previous match, wrapping around. */
  stepMatch(direction: 1 | -1): void {
    const { matches } = this.search;
    const current = this.search.active >= 0 ? matches[this.search.active] : undefined;
    const from = current ?? this.selectedRow();
    const index = nextMatch(matches, from ?? null, direction);
    if (index === null) return;
    const row = matches[index];
    if (row === undefined) return;
    this.search = { ...this.search, active: index };
    this.selectRow(row, 'center');
  }

  isMatch(row: number): boolean {
    return this.search.matches.length > 0 && matchIndex(this.search.matches, row) >= 0;
  }
}

const sources = new Map<number, GraphSource>();

export function getGraphSource(repoId: number): GraphSource {
  let source = sources.get(repoId);
  if (!source) {
    source = new GraphSource(repoId);
    sources.set(repoId, source);
  }
  return source;
}

/** Called on `refsChanged`, also for repositories whose tab is in the background. */
export function invalidateGraph(repoId: number): void {
  sources.get(repoId)?.invalidate();
}

/** Called on `graphProgress`. */
export function graphWalkProgress({ repoId, ...progress }: GraphProgress): void {
  sources.get(repoId)?.walkProgress(progress);
}

// A closed repository forgets its graph state.
useRepoSessions.subscribe((state) => {
  for (const repoId of sources.keys()) {
    if (state.sessions[repoId]?.status !== 'open' && state.sessions[repoId]?.status !== 'opening') {
      sources.get(repoId)?.dispose();
      sources.delete(repoId);
    }
  }
});

export function useGraphSource(repoId: number): GraphSource {
  const source = getGraphSource(repoId);
  useSyncExternalStore(source.subscribe, source.getSnapshot);
  return source;
}
