import { useTabsStore, type ShellTab } from '../../app/tabs/tabsStore';
import type { MessageKey, MessageParams } from '../../i18n/i18n';
import type { ChangedFile, DiffTarget, RepoRefs } from '../../ipc';
import { resolvedShortcut } from '../keybindings/registry';
import { revealCommit } from '../repo/graphNavigation';
import { revealRef } from '../sidebar/refActions';
import { pushRecent } from '../sidebar/sidebarUiState';
import { allChoices } from '../toolbar/branchChoices';
import {
  disabledReasonOf,
  isActionEnabled,
  type PaletteAction,
  ACTION_GROUPS,
} from './actionRegistry';
import type { PaletteItem } from './paletteItems';

export type Translate = (key: MessageKey, params?: MessageParams) => string;

/** Disabled actions sink below everything that can run. */
const DISABLED_BOOST = -20;

/** Actions in display order: enabled before disabled, then by group, then by title. */
export function buildActionItems(actions: readonly PaletteAction[], t: Translate): PaletteItem[] {
  const groupRank = (action: PaletteAction) => ACTION_GROUPS.indexOf(action.group);
  return actions
    .map((action) => ({ action, enabled: isActionEnabled(action), title: t(action.title) }))
    .sort(
      (a, b) =>
        Number(b.enabled) - Number(a.enabled) ||
        groupRank(a.action) - groupRank(b.action) ||
        a.title.localeCompare(b.title),
    )
    .map(({ action, enabled, title }) => ({
      key: `action:${action.id}`,
      kind: 'action',
      label: title,
      shortcut: resolvedShortcut(action.id) ?? undefined,
      disabled: !enabled,
      disabledReason: enabled ? undefined : disabledReasonOf(action),
      boost: enabled ? (action.boost ?? 0) : DISABLED_BOOST,
      activate: action.run,
      keepsPaletteOpen: action.keepsPaletteOpen,
    }));
}

/** Adds the branch to the recent branches of its tab, like the branch selector does. */
function rememberBranch(repoId: number, name: string): void {
  const { tabs, updateSidebar } = useTabsStore.getState();
  const tab = tabs.find((candidate) => candidate.repoId === repoId);
  if (tab) updateSidebar(tab.id, (sidebar) => pushRecent(sidebar, name));
}

const refItemCache = new WeakMap<RepoRefs, PaletteItem[]>();

/** Cached per `RepoRefs` object (refetched on `refs-changed`): building 10k items is not free. */
export function refItemsFor(refs: RepoRefs, repoId: number): PaletteItem[] {
  let items = refItemCache.get(refs);
  if (!items) {
    items = buildRefItems(refs, repoId);
    refItemCache.set(refs, items);
  }
  return items;
}

/** Branches (local and remote) and tags of the repository, revealed in the graph on pick. */
export function buildRefItems(refs: RepoRefs, repoId: number): PaletteItem[] {
  const items: PaletteItem[] = allChoices(refs).map((choice) => ({
    key: `ref:${choice.name}`,
    kind: 'branch',
    label: choice.name,
    boost: choice.current ? 1 : 0,
    activate: () => {
      rememberBranch(repoId, choice.name);
      revealRef(repoId, choice.target, refs.graphVersion);
    },
  }));
  for (const tag of refs.tags) {
    items.push({
      key: `tag:${tag.name}`,
      kind: 'tag',
      label: tag.name,
      detail: tag.message ?? undefined,
      activate: () => {
        revealRef(repoId, { kind: 'tag', tag }, refs.graphVersion);
      },
    });
  }
  return items;
}

export interface TabLabel {
  tab: ShellTab;
  name: string;
}

/** Other tabs of the window; activating one switches to it. */
export function buildTabItems(
  tabs: readonly TabLabel[],
  activeTabId: string,
  activate: (tabId: string) => void,
): PaletteItem[] {
  return tabs
    .filter(({ tab }) => tab.id !== activeTabId)
    .map(({ tab, name }) => ({
      key: `tab:${tab.repoId === null ? tab.id : String(tab.repoId)}`,
      kind: 'tab',
      label: name,
      activate: () => {
        activate(tab.id);
      },
    }));
}

export interface CommitHit {
  sha: string;
  row: number;
  /** Graph version of `row`. */
  version: number;
  summary: string;
  author: string;
}

export function buildCommitItems(hits: readonly CommitHit[], repoId: number): PaletteItem[] {
  return hits.map((hit) => ({
    key: `commit:${hit.sha}`,
    kind: 'commit',
    label: hit.summary,
    detail: `${hit.sha.slice(0, 7)} · ${hit.author}`,
    activate: () => {
      revealCommit(repoId, hit.sha, hit.row, hit.version);
    },
  }));
}

export interface FileSource {
  target: DiffTarget;
  /** Short description of where the files come from, shown next to each. */
  origin: string;
  files: readonly ChangedFile[];
}

export function buildFileItems(
  sources: readonly FileSource[],
  open: (target: DiffTarget, file: ChangedFile) => void,
): PaletteItem[] {
  return sources.flatMap(({ target, origin, files }) =>
    files.map((file) => ({
      key: `file:${origin}:${file.path}`,
      kind: 'file' as const,
      label: file.path,
      detail: origin,
      activate: () => {
        open(target, file);
      },
    })),
  );
}
