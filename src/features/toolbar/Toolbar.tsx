import { useShortcut } from '../keybindings/registry';
import { useTabsStore, type ShellTab } from '../../app/tabs/tabsStore';
import { useT } from '../../i18n/useT';
import type { RepoInfo, RepoState } from '../../ipc';
import { IconButton } from '../../ui/IconButton';
import { openCreateBranchFromHead, openCreateTagFromHead } from '../refs/refCommands';
import { popLatestStash } from '../refs/refOps';
import { useRepoRefs } from '../sidebar/useRepoRefs';
import { UndoButtons } from '../undo/UndoButtons';
import { usePreferences } from '../../app/usePreferences';
import { toggleTerminalPanel } from '../terminal/terminalActions';
import { useRepoTerminals } from '../terminal/terminalStore';
import { BranchSelector } from './BranchSelector';
import { NetworkButtons } from './NetworkButtons';
import { openRepoFolder } from './openRepoFolder';
import styles from './Toolbar.module.css';
import { StashButton } from './StashButton';
import { ToolbarButton } from './ToolbarButton';

/** Repository toolbar: network actions, branch, tag, stash and pop, terminal, file manager. */
export function Toolbar({ tab, repo, state }: { tab: ShellTab; repo: RepoInfo; state: RepoState }) {
  const t = useT();
  const branchShortcut = useShortcut('git.branch.create');
  const tagShortcut = useShortcut('git.tag.create');
  const popShortcut = useShortcut('git.stash.pop');
  const sidebarShortcut = useShortcut('view.sidebar');
  const detailsShortcut = useShortcut('view.details');
  const terminalShortcut = useShortcut('terminal.toggle');
  const integrated = usePreferences().terminalMode === 'integrated';
  const terminalOpen = useRepoTerminals(repo.id).open;
  const setPanel = useTabsStore((store) => store.setPanel);
  const refs = useRepoRefs(repo.id).data;
  const { sidebar, details } = tab.panels;
  const unborn = state.head.kind === 'unborn';

  return (
    <div role="toolbar" aria-label={t('toolbar.label')} className={styles.toolbar}>
      <UndoButtons repoId={repo.id} />
      <span className={styles.separator} />
      <NetworkButtons repoId={repo.id} state={state} />
      <span className={styles.separator} />
      <ToolbarButton
        icon="branch"
        label={t('toolbar.branch')}
        command="git switch -c"
        shortcut={branchShortcut}
        onClick={() => {
          void openCreateBranchFromHead(repo.id);
        }}
      />
      <ToolbarButton
        icon="tag"
        label={t('toolbar.tag')}
        description={unborn ? t('refs.createTag.unborn') : undefined}
        command="git tag"
        shortcut={tagShortcut}
        disabled={unborn}
        onClick={() => {
          void openCreateTagFromHead(repo.id);
        }}
      />
      <StashButton repoId={repo.id} state={state} />
      <ToolbarButton
        icon="pop"
        label={t('toolbar.pop')}
        command="git stash pop"
        shortcut={popShortcut}
        disabled={refs !== undefined && refs.stashes.length === 0}
        onClick={() => {
          void popLatestStash(repo.id);
        }}
      />
      <span className={styles.separator} />
      <ToolbarButton
        icon="terminal"
        label={t('toolbar.terminal')}
        description={t(
          integrated ? 'toolbar.terminal.integratedTooltip' : 'toolbar.terminal.tooltip',
        )}
        command={repo.path}
        shortcut={terminalShortcut}
        aria-pressed={integrated ? terminalOpen : undefined}
        onClick={() => {
          void toggleTerminalPanel(repo.id);
        }}
      />
      <ToolbarButton
        icon="folderOpen"
        label={t('toolbar.fileManager')}
        description={t('toolbar.fileManager.tooltip')}
        command={repo.path}
        onClick={() => {
          void openRepoFolder(repo.id);
        }}
      />

      <div className={styles.end}>
        <BranchSelector tab={tab} repoId={repo.id} state={state} />
        <span className={styles.separator} />
        <IconButton
          icon="panelLeft"
          size="sm"
          label={t('layout.toggleSidebar')}
          shortcut={sidebarShortcut}
          aria-pressed={!sidebar.collapsed}
          onClick={() => {
            setPanel(tab.id, 'sidebar', { collapsed: !sidebar.collapsed });
          }}
        />
        <IconButton
          icon="panelRight"
          size="sm"
          label={t('layout.toggleDetails')}
          shortcut={detailsShortcut}
          aria-pressed={!details.collapsed}
          onClick={() => {
            setPanel(tab.id, 'details', { collapsed: !details.collapsed });
          }}
        />
      </div>
    </div>
  );
}
