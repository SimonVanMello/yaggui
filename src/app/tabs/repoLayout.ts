import {
  DEFAULT_COLUMNS,
  parseGraphColumns,
  type GraphColumns,
} from '../../features/graph/columns';
import {
  DEFAULT_SIDEBAR_UI,
  parseSidebarUiState,
  type SidebarUiState,
} from '../../features/sidebar/sidebarUiState';
import { ipc, unwrap } from '../../ipc';
import {
  DEFAULT_PANELS,
  parseTabUiState,
  serializeTabUiState,
  type TabPanels,
} from '../layout/panels';
import { useTabsStore, type ShellTab } from './tabsStore';

/**
 * Layout of a repository's view: side panel sizes, sidebar sections, graph columns. Saved per repository so that
 * reopening a closed repository finds it as it was; the tab keeps a copy for the restoration.
 */
export interface RepoLayout {
  panels: TabPanels;
  sidebar: SidebarUiState;
  columns: GraphColumns;
}

export const DEFAULT_REPO_LAYOUT: RepoLayout = {
  panels: DEFAULT_PANELS,
  sidebar: DEFAULT_SIDEBAR_UI,
  columns: DEFAULT_COLUMNS,
};

/** Same shape as the matching slices of a tab's UI state, so the same parsers read both. */
export function serializeRepoLayout(layout: RepoLayout): string {
  return serializeTabUiState(layout.panels, {
    graph: { columns: layout.columns },
    sidebar: layout.sidebar,
  });
}

export function parseRepoLayout(json: string | null): RepoLayout {
  return {
    panels: parseTabUiState(json),
    sidebar: parseSidebarUiState(json),
    columns: parseGraphColumns(json),
  };
}

/** Last layout read or written per repository, to skip saving what is already stored. */
const stored = new Map<number, string>();
/** Saves waiting for their delay, per repository. */
const pending = new Map<number, { timer: ReturnType<typeof setTimeout>; json: string }>();
/** Saves sent and not answered yet, per repository. */
const inFlight = new Map<number, Promise<void>>();
let warned = false;

function save(repoId: number, json: string): Promise<void> {
  stored.set(repoId, json);
  const done = ipc.commands.saveRepoUiState(repoId, json).then((result) => {
    if (inFlight.get(repoId) === done) inFlight.delete(repoId);
    if (result.status === 'error') {
      stored.delete(repoId);
      if (!warned) {
        warned = true;
        console.warn('Repository layout could not be saved', result.error);
      }
    }
  });
  inFlight.set(repoId, done);
  return done;
}

/** Writes a pending save of the repository now, and waits for it, so that a read sees it. */
function flush(repoId: number): Promise<void> {
  const waiting = pending.get(repoId);
  if (!waiting) return inFlight.get(repoId) ?? Promise.resolve();
  clearTimeout(waiting.timer);
  pending.delete(repoId);
  return save(repoId, waiting.json);
}

/** Writes every pending save now (before the window closes). */
export function flushRepoLayouts(): Promise<void> {
  return Promise.all([...pending.keys()].map(flush)).then(() => undefined);
}

/** The saved layout of a repository; the default one when none is saved or it is unreadable. */
export async function loadRepoLayout(repoId: number): Promise<RepoLayout> {
  try {
    // A tab closed right after a change may still hold the newest layout in a pending save.
    await flush(repoId);
    const json = await unwrap(ipc.commands.getRepoUiState(repoId));
    const layout = parseRepoLayout(json);
    stored.set(repoId, serializeRepoLayout(layout));
    return layout;
  } catch (error) {
    console.warn('Repository layout unavailable, using the default one', error);
    return DEFAULT_REPO_LAYOUT;
  }
}

function layoutOf(tab: ShellTab): RepoLayout {
  return { panels: tab.panels, sidebar: tab.sidebar, columns: tab.columns };
}

/**
 * Saves the layout of a repository shortly after it changes in its tab. The tabs restored at
 * startup are saved once too, which carries over the layouts kept only in tabs before.
 */
export function persistRepoLayouts(delayMs: number): () => void {
  const schedule = (repoId: number, layout: RepoLayout) => {
    const json = serializeRepoLayout(layout);
    const waiting = pending.get(repoId);
    if (waiting) clearTimeout(waiting.timer);
    pending.delete(repoId);
    if (stored.get(repoId) === json) return;
    const timer = setTimeout(() => {
      pending.delete(repoId);
      void save(repoId, json);
    }, delayMs);
    pending.set(repoId, { timer, json });
  };

  for (const tab of useTabsStore.getState().tabs) {
    if (tab.repoId !== null) schedule(tab.repoId, layoutOf(tab));
  }
  const unsubscribe = useTabsStore.subscribe((state, previous) => {
    if (state.tabs === previous.tabs) return;
    const before = new Map(previous.tabs.map((tab) => [tab.id, tab]));
    for (const tab of state.tabs) {
      if (tab.repoId === null) continue;
      const old = before.get(tab.id);
      const same =
        old?.repoId === tab.repoId &&
        old.panels === tab.panels &&
        old.sidebar === tab.sidebar &&
        old.columns === tab.columns;
      if (same) continue;
      schedule(tab.repoId, layoutOf(tab));
    }
  });
  return unsubscribe;
}

/** Forgets what is known to be stored and drops the pending saves (tests). */
export function resetStoredLayouts(): void {
  pending.forEach(({ timer }) => {
    clearTimeout(timer);
  });
  pending.clear();
  inFlight.clear();
  stored.clear();
}
