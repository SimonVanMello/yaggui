import { defaultShortcutOf, execShellAction, type ShellAction } from '../../app/shellActions';
import { useThemeStore, type ThemePreference } from '../../theme/themeStore';
import { queryClient, queryKeys } from '../../app/queryClient';
import type { RepoState, UndoState } from '../../ipc';
import { openHistoryDialog } from '../history/historyDialogsStore';
import {
  abortOperation,
  cherryPickSelection,
  operationOf,
  resetToSelection,
  revertSelection,
  skipOperation,
  startContinue,
} from '../history/historyOps';
import { GRAPH_TOOL_ACTIONS } from '../compare/graphToolActions';
import { INSPECT_ACTIONS } from '../inspect/inspectActions';
import { fetchTags, forcePushRepo, pushAllTags } from '../network/networkOps';
import { openRemoteDialog } from '../remotes/remoteDialogsStore';
import { useGraphNavigation } from '../repo/graphNavigation';
import { openInteractiveRebase } from '../rebase/rebaseStore';
import { activeRepoId } from '../repo/repoSessions';
import { FOCUS_REFS_FILTER_EVENT } from '../sidebar/RefsSidebar';
import { openCommitToolsDialog, useCommitTools } from '../staging/commitToolsStore';
import { COMMIT_EVENT } from '../staging/commitUi';
import { openInEditor } from '../terminal/openInEditor';
import { openTerminal } from '../terminal/openTerminal';
import { openNewTerminal, toggleTerminalFromKeyboard } from '../terminal/terminalActions';
import { openRepoFolder } from '../toolbar/openRepoFolder';
import { canRun } from '../undo/undoState';
import { checkForUpdatesNow } from '../updates/updates';
import { registerActions, type PaletteAction } from './actionRegistry';

const hasRepo = () => activeRepoId() !== null;
const inOperation = () => {
  const repoId = activeRepoId();
  return repoId !== null && operationOf(repoId) !== null;
};
/** History actions start something new: they wait for the operation in progress to end. */
const canStartHistory = () => hasRepo() && !inOperation();

/** Runs `work` on the active repository, if any. */
function onRepo(work: (repoId: number) => unknown): () => void {
  return () => {
    const repoId = activeRepoId();
    if (repoId !== null) void work(repoId);
  };
}

/** Undo and redo are listed greyed out when the toolbar buttons are (nothing to do, blocked). */
function undoEnabled(direction: 'undo' | 'redo'): () => boolean {
  return () => {
    const repoId = activeRepoId();
    if (repoId === null) return false;
    const state = queryClient.getQueryData<UndoState>(queryKeys.undoState(repoId));
    return canRun(state, direction);
  };
}

function shell(
  id: string,
  action: ShellAction,
  title: PaletteAction['title'],
  group: PaletteAction['group'],
  enabled?: () => boolean,
): PaletteAction {
  return {
    id,
    title,
    group,
    shortcut: defaultShortcutOf(action),
    enabled,
    run: () => {
      execShellAction(action);
    },
  };
}

function theme(preference: ThemePreference, title: PaletteAction['title']): PaletteAction {
  return {
    id: `view.theme.${preference}`,
    title,
    group: 'view',
    enabled: () => useThemeStore.getState().preference !== preference,
    run: () => {
      useThemeStore.getState().setPreference(preference);
    },
  };
}

const BUILTIN: readonly PaletteAction[] = [
  shell('repo.open', 'openRepo', 'palette.action.repo.open', 'repo'),
  shell('repo.clone', 'cloneRepo', 'palette.action.repo.clone', 'repo'),
  shell('repo.init', 'initRepo', 'palette.action.repo.init', 'repo'),
  {
    id: 'repo.terminal',
    title: 'palette.action.repo.terminal',
    group: 'repo',
    enabled: hasRepo,
    run: () => {
      const repoId = activeRepoId();
      if (repoId !== null) void openTerminal(repoId);
    },
  },
  {
    id: 'repo.fileManager',
    title: 'palette.action.repo.fileManager',
    group: 'repo',
    enabled: hasRepo,
    run: onRepo(openRepoFolder),
  },
  {
    id: 'terminal.toggle',
    title: 'palette.action.terminal.toggle',
    group: 'view',
    // The key left of 1, whatever the layout (VS Code's default).
    shortcut: 'Ctrl+`',
    enabled: hasRepo,
    run: onRepo(toggleTerminalFromKeyboard),
  },
  {
    id: 'terminal.new',
    title: 'palette.action.terminal.new',
    group: 'view',
    shortcut: 'Ctrl+Shift+`',
    enabled: hasRepo,
    run: onRepo(openNewTerminal),
  },
  {
    id: 'repo.editor',
    title: 'palette.action.repo.editor',
    group: 'repo',
    enabled: hasRepo,
    run: onRepo((repoId) => openInEditor(repoId)),
  },
  {
    id: 'repo.refsFilter',
    title: 'palette.action.repo.refsFilter',
    group: 'repo',
    shortcut: 'Mod+Shift+R',
    enabled: hasRepo,
    run: () => {
      window.dispatchEvent(new Event(FOCUS_REFS_FILTER_EVENT));
    },
  },
  shell('tab.new', 'newTab', 'palette.action.tab.new', 'tabs'),
  shell('tab.close', 'closeTab', 'palette.action.tab.close', 'tabs'),
  shell('tab.next', 'nextTab', 'palette.action.tab.next', 'tabs'),
  shell('tab.previous', 'previousTab', 'palette.action.tab.previous', 'tabs'),
  shell('view.sidebar', 'toggleSidebar', 'palette.action.view.sidebar', 'view', hasRepo),
  shell('view.details', 'toggleDetails', 'palette.action.view.details', 'view', hasRepo),
  shell('view.log', 'toggleLog', 'palette.action.view.log', 'view'),
  theme('system', 'palette.action.view.theme.system'),
  theme('light', 'palette.action.view.theme.light'),
  theme('dark', 'palette.action.view.theme.dark'),
  shell('app.preferences', 'preferences', 'palette.action.app.preferences', 'app'),
  shell('app.terminalSettings', 'terminalSettings', 'palette.action.app.terminal', 'app'),
  shell('app.shortcuts', 'shortcuts', 'palette.action.app.shortcuts', 'app'),
  shell('app.changelog', 'changelog', 'palette.action.app.changelog', 'app'),
  {
    id: 'app.checkUpdates',
    title: 'palette.action.app.checkUpdates',
    group: 'app',
    run: () => void checkForUpdatesNow(),
  },
  shell('git.fetch', 'fetch', 'palette.action.git.fetch', 'git', hasRepo),
  shell('git.pull', 'pull', 'palette.action.git.pull', 'git', hasRepo),
  shell('git.push', 'push', 'palette.action.git.push', 'git', hasRepo),
  {
    id: 'git.forcePush',
    title: 'palette.action.git.forcePush',
    group: 'git',
    enabled: hasRepo,
    run: () => {
      const repoId = activeRepoId();
      if (repoId !== null) void forcePushRepo(repoId);
    },
  },
  {
    id: 'git.commit',
    title: 'palette.action.git.commit',
    group: 'git',
    shortcut: 'Mod+Enter',
    enabled: hasRepo,
    run: () => {
      window.dispatchEvent(new Event(COMMIT_EVENT));
    },
  },
  {
    id: 'git.rebaseInteractive',
    title: 'palette.action.git.rebaseInteractive',
    group: 'git',
    enabled: canStartHistory,
    run: onRepo((repoId) => {
      const state = queryClient.getQueryData<RepoState>(queryKeys.repoState(repoId));
      const head = state?.head.kind === 'unborn' ? null : (state?.head.oid ?? null);
      const selected = useGraphNavigation.getState().selected[repoId] ?? null;
      // The selected commit is the base; HEAD itself would leave nothing to rebase.
      openInteractiveRebase(repoId, selected !== null && selected !== head ? selected : null);
    }),
  },
  shell('git.branch.create', 'createBranch', 'palette.action.git.branchCreate', 'git', hasRepo),
  shell('git.tag.create', 'createTag', 'palette.action.git.tagCreate', 'git', hasRepo),
  {
    id: 'git.merge',
    title: 'palette.action.git.merge',
    group: 'git',
    enabled: canStartHistory,
    run: onRepo((repoId) => {
      openHistoryDialog({ kind: 'merge', repoId, source: null, target: null });
    }),
  },
  {
    id: 'git.rebase',
    title: 'palette.action.git.rebase',
    group: 'git',
    enabled: canStartHistory,
    run: onRepo((repoId) => {
      openHistoryDialog({ kind: 'rebase', repoId, branch: null, onto: null });
    }),
  },
  {
    id: 'git.cherryPick',
    title: 'palette.action.git.cherryPick',
    group: 'git',
    enabled: canStartHistory,
    run: onRepo(cherryPickSelection),
  },
  {
    id: 'git.revert',
    title: 'palette.action.git.revert',
    group: 'git',
    enabled: canStartHistory,
    run: onRepo(revertSelection),
  },
  {
    id: 'git.reset',
    title: 'palette.action.git.reset',
    group: 'git',
    enabled: canStartHistory,
    run: onRepo(resetToSelection),
  },
  {
    id: 'git.continue',
    title: 'palette.action.git.continue',
    group: 'git',
    enabled: inOperation,
    run: onRepo(startContinue),
  },
  {
    id: 'git.skip',
    title: 'palette.action.git.skip',
    group: 'git',
    enabled: inOperation,
    run: onRepo(skipOperation),
  },
  {
    id: 'git.abort',
    title: 'palette.action.git.abort',
    group: 'git',
    enabled: inOperation,
    run: onRepo(abortOperation),
  },
  {
    id: 'git.remote.add',
    title: 'palette.action.git.remoteAdd',
    group: 'git',
    enabled: hasRepo,
    run: onRepo((repoId) => {
      openRemoteDialog({ kind: 'edit', repoId, remote: null, fromManage: false });
    }),
  },
  {
    id: 'git.remote.manage',
    title: 'palette.action.git.remotes',
    group: 'git',
    enabled: hasRepo,
    run: onRepo((repoId) => {
      openRemoteDialog({ kind: 'manage', repoId });
    }),
  },
  {
    id: 'git.tags.fetch',
    title: 'palette.action.git.tagsFetch',
    group: 'git',
    enabled: hasRepo,
    run: onRepo((repoId) => fetchTags(repoId, null)),
  },
  {
    // To the default remote (`origin` first); the sidebar offers each remote.
    id: 'git.tags.pushAll',
    title: 'palette.action.git.tagsPushAll',
    group: 'git',
    enabled: hasRepo,
    run: onRepo((repoId) => pushAllTags(repoId, null)),
  },
  {
    ...shell('edit.undo', 'undo', 'palette.action.edit.undo', 'git', undoEnabled('undo')),
    runWhenDisabled: true,
  },
  {
    ...shell('edit.redo', 'redo', 'palette.action.edit.redo', 'git', undoEnabled('redo')),
    runWhenDisabled: true,
  },
  shell('edit.history', 'opHistory', 'palette.action.edit.history', 'git', hasRepo),
  shell('git.stash', 'stash', 'palette.action.git.stash', 'git', hasRepo),
  shell('git.stash.pop', 'stashPop', 'palette.action.git.stashPop', 'git', hasRepo),
  {
    id: 'git.commit.templates',
    title: 'palette.action.commit.templates',
    group: 'git',
    run: () => {
      openCommitToolsDialog({ kind: 'templates', repoId: activeRepoId() });
    },
  },
  {
    id: 'git.commit.conventional',
    title: 'palette.action.commit.conventional',
    group: 'git',
    enabled: hasRepo,
    run: () => {
      const tools = useCommitTools.getState();
      tools.setConventional(!tools.conventional);
    },
  },
  {
    id: 'git.identity.profiles',
    title: 'palette.action.identity.profiles',
    group: 'git',
    run: () => {
      openCommitToolsDialog({ kind: 'profiles', repoId: activeRepoId() });
    },
  },
  ...INSPECT_ACTIONS,
  ...GRAPH_TOOL_ACTIONS,
];

/** Registers the actions of the shell; returns the function that removes them. */
export function registerBuiltinActions(): () => void {
  return registerActions(BUILTIN);
}
