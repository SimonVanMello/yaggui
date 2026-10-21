import { queryClient } from '../../app/queryClient';
import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { ipc, type GraphFilter } from '../../ipc';
import { showYagguiError } from '../../app/errors/presentError';
import { useDiffStore } from '../diff/diffStore';
import {
  EMPTY_FILTER,
  graphFilterKey,
  isFilterActive,
  setFirstParent,
  showAll,
  updateGraphFilter,
} from '../graph/graphFilter';
import { getGraphSource } from '../graph/graphSource';
import type { PaletteAction } from '../palette/actionRegistry';
import { activeRepoId } from '../repo/repoSessions';
import { openBranchTools } from './branchToolsStore';
import { compareCommits, jumpToMergeBase } from './compareActions';

const hasRepo = () => activeRepoId() !== null;

function filterOf(repoId: number): GraphFilter {
  return queryClient.getQueryData<GraphFilter>(graphFilterKey(repoId)) ?? EMPTY_FILTER;
}

/** Two commits picked in the graph of the active repository. */
function twoPicked() {
  const repoId = activeRepoId();
  if (repoId === null) return null;
  const picked = getGraphSource(repoId).selectedCommits();
  return picked.length === 2 ? { repoId, picked } : null;
}

/** The diff on screen in the active tab. */
function openDiff() {
  const tab = selectActiveTab(useTabsStore.getState());
  if (tab.repoId === null) return null;
  const diff = useDiffStore.getState().open[tab.id];
  return diff?.repoId === tab.repoId ? diff : null;
}

/**
 * Palette actions of M4-7b (F-028 to F-030, F-087, F-104, F-105) and first-parent mode (F-032);
 * ids are public, never renamed.
 */
export const GRAPH_TOOL_ACTIONS: readonly PaletteAction[] = [
  {
    id: 'graph.showAll',
    title: 'palette.action.graph.showAll',
    group: 'view',
    enabled: () => {
      const repoId = activeRepoId();
      return repoId !== null && isFilterActive(filterOf(repoId));
    },
    disabledReason: () =>
      activeRepoId() === null ? 'palette.disabled.noRepo' : 'palette.disabled.noFilter',
    run: () => {
      const repoId = activeRepoId();
      if (repoId !== null) void showAll(repoId);
    },
  },
  {
    id: 'graph.toggleRemotes',
    title: 'palette.action.graph.toggleRemotes',
    group: 'view',
    enabled: hasRepo,
    run: () => {
      const repoId = activeRepoId();
      if (repoId !== null) {
        void updateGraphFilter(repoId, (f) => ({ ...f, hideRemotes: !f.hideRemotes }));
      }
    },
  },
  {
    id: 'graph.toggleStashes',
    title: 'palette.action.graph.toggleStashes',
    group: 'view',
    enabled: hasRepo,
    run: () => {
      const repoId = activeRepoId();
      if (repoId !== null) {
        void updateGraphFilter(repoId, (f) => ({ ...f, hideStashes: !f.hideStashes }));
      }
    },
  },
  {
    id: 'graph.toggleFirstParent',
    title: 'palette.action.graph.toggleFirstParent',
    shortcut: 'Mod+Alt+P',
    group: 'view',
    enabled: hasRepo,
    run: () => {
      const repoId = activeRepoId();
      if (repoId !== null) void setFirstParent(repoId);
    },
  },
  {
    id: 'graph.goToMergeBase',
    title: 'palette.action.graph.goToMergeBase',
    group: 'repo',
    enabled: () => twoPicked() !== null,
    disabledReason: () => 'palette.disabled.pickTwoCommits',
    run: () => {
      const two = twoPicked();
      const [a, b] = two?.picked ?? [];
      if (two && a && b) void jumpToMergeBase(two.repoId, a.sha, b.sha);
    },
  },
  {
    id: 'graph.compareSelected',
    title: 'palette.action.graph.compareSelected',
    group: 'repo',
    enabled: () => twoPicked() !== null,
    disabledReason: () => 'palette.disabled.pickTwoCommits',
    run: () => {
      const two = twoPicked();
      if (two) compareCommits(two.repoId, two.picked);
    },
  },
  {
    id: 'branch.compare',
    title: 'palette.action.branch.compare',
    group: 'git',
    enabled: hasRepo,
    run: () => {
      const repoId = activeRepoId();
      if (repoId !== null) openBranchTools({ kind: 'compareBranches', repoId, a: null });
    },
  },
  {
    id: 'branch.cleanup',
    title: 'palette.action.branch.cleanup',
    group: 'git',
    enabled: hasRepo,
    run: () => {
      const repoId = activeRepoId();
      if (repoId !== null) openBranchTools({ kind: 'cleanup', repoId });
    },
  },
  {
    id: 'diff.externalTool',
    title: 'palette.action.diff.externalTool',
    group: 'repo',
    enabled: () => openDiff() !== null,
    disabledReason: () => 'palette.disabled.noDiff',
    run: () => {
      const diff = openDiff();
      if (!diff) return;
      void ipc.commands
        .runDiffTool(diff.repoId, diff.target, diff.path, diff.oldPath)
        .then((result) => {
          if (result.status === 'error') showYagguiError(result.error);
        });
    },
  },
];
