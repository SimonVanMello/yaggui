import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { useDiffStore } from '../diff/diffStore';
import type { PaletteAction } from '../palette/actionRegistry';
import { useGraphNavigation } from '../repo/graphNavigation';
import { activeRepoId } from '../repo/repoSessions';
import {
  inspectViewOf,
  openBlame,
  openFileHistory,
  openLineHistory,
  openReflog,
  openTree,
} from './inspectStore';
import { selectedLines } from './lineSelection';

interface CurrentFile {
  repoId: number;
  path: string;
  /** Version shown: a commit, or `null` for the working tree. */
  rev: string | null;
}

/** The file on screen in the active tab: its open diff, or the file of a history / blame. */
export function currentFile(): CurrentFile | null {
  const tab = selectActiveTab(useTabsStore.getState());
  if (tab.repoId === null) return null;
  const diff = useDiffStore.getState().open[tab.id];
  if (diff?.repoId === tab.repoId) {
    return {
      repoId: tab.repoId,
      path: diff.path,
      rev: diff.target.kind === 'commits' ? diff.target.to : null,
    };
  }
  const view = inspectViewOf(tab.repoId);
  if (view?.kind === 'blame') return { repoId: tab.repoId, ...view.target };
  if (view?.kind === 'fileHistory' || view?.kind === 'lineHistory')
    return { repoId: tab.repoId, path: view.path, rev: view.rev };
  return null;
}

/** The lines selected in the active repository's blame or commit diff. */
function activeLines() {
  const repoId = activeRepoId();
  const range = repoId === null ? null : selectedLines(repoId);
  return repoId === null || range === null ? null : { repoId, range };
}

/**
 * Palette actions of M4-4 (F-220 to F-222), M7-7 (F-223) and M7-8 (F-224); ids are public,
 * never renamed.
 */
export const INSPECT_ACTIONS: readonly PaletteAction[] = [
  {
    id: 'file.history',
    title: 'palette.action.file.history',
    group: 'repo',
    enabled: () => currentFile() !== null,
    run: () => {
      const file = currentFile();
      if (file) openFileHistory(file.repoId, file.path);
    },
  },
  {
    id: 'file.blame',
    title: 'palette.action.file.blame',
    group: 'repo',
    enabled: () => currentFile() !== null,
    run: () => {
      const file = currentFile();
      if (file) openBlame(file.repoId, file.path, file.rev);
    },
  },
  {
    id: 'file.lineHistory',
    title: 'palette.action.file.lineHistory',
    group: 'repo',
    enabled: () => activeLines() !== null,
    disabledReason: () =>
      activeRepoId() === null ? 'palette.disabled.noRepo' : 'palette.disabled.noLines',
    run: () => {
      const lines = activeLines();
      if (lines) openLineHistory(lines.repoId, lines.range);
    },
  },
  {
    id: 'tree.browse',
    title: 'palette.action.tree.browse',
    group: 'repo',
    enabled: () => activeRepoId() !== null,
    run: () => {
      const repoId = activeRepoId();
      if (repoId !== null)
        openTree(repoId, useGraphNavigation.getState().selected[repoId] ?? 'HEAD');
    },
  },
  {
    id: 'repo.reflog',
    title: 'palette.action.repo.reflog',
    group: 'repo',
    enabled: () => activeRepoId() !== null,
    run: () => {
      const repoId = activeRepoId();
      if (repoId !== null) openReflog(repoId, 'HEAD');
    },
  },
];
