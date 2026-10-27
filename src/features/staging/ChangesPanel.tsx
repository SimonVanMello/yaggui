import { useT } from '../../i18n/useT';
import type { RepoState } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/Icon';
import { execShellAction } from '../../app/shellActions';
import { Kbd } from '../../ui/Kbd';
import { useShortcut } from '../keybindings/registry';
import { WorktreeChanges } from '../diff/WorktreeChanges';
import { changedFiles, workingBranch } from '../repo/repoStatus';
import { CommitBox } from './CommitBox';
import styles from './ChangesPanel.module.css';

function NextAction({
  icon,
  label,
  shortcut,
  onClick,
}: {
  icon: IconName;
  label: string;
  shortcut: string | undefined;
  onClick: () => void;
}) {
  return (
    <Button size="sm" className={styles.nextAction} onClick={onClick}>
      <Icon name={icon} />
      <span className={styles.nextLabel}>{label}</span>
      {shortcut && <Kbd shortcut={shortcut} />}
    </Button>
  );
}

/**
 * Right panel: staged and unstaged files with their actions, then the commit area. A clean
 * tree gets a useful empty state (spec §6.4).
 */
export function ChangesPanel({
  state,
  repoId,
  tabId,
}: {
  state: RepoState;
  repoId: number;
  tabId: string;
}) {
  const t = useT();
  const pullShortcut = useShortcut('git.pull');
  const branchShortcut = useShortcut('git.branch.create');
  const fetchShortcut = useShortcut('git.fetch');
  const branch = workingBranch(state);
  const clean = changedFiles(state) === 0;

  return (
    <section className={styles.panel} aria-label={t('changes.label')}>
      <header className={styles.header}>
        <Icon name="commit" />
        <b>{t('changes.title')}</b>
        {branch && <span className={styles.branch}>{branch}</span>}
      </header>

      {clean ? (
        <div className={styles.empty}>
          <Icon name="check" size="lg" className={styles.cleanIcon} />
          <p className={styles.emptyTitle}>{t('changes.clean')}</p>
          <p className={styles.emptyText}>{t('changes.cleanHint')}</p>
          {/* Likely next actions (spec §6.4). */}
          <div className={styles.nextActions}>
            {state.upstream && state.upstream.behind > 0 && (
              <NextAction
                icon="pull"
                label={t('changes.next.pull', { count: state.upstream.behind })}
                shortcut={pullShortcut}
                onClick={() => {
                  execShellAction('pull');
                }}
              />
            )}
            <NextAction
              icon="branch"
              label={t('changes.next.branch')}
              shortcut={branchShortcut}
              onClick={() => {
                execShellAction('createBranch');
              }}
            />
            {state.upstream && state.upstream.behind === 0 && (
              <NextAction
                icon="fetch"
                label={t('changes.next.fetch')}
                shortcut={fetchShortcut}
                onClick={() => {
                  execShellAction('fetch');
                }}
              />
            )}
          </div>
        </div>
      ) : (
        <WorktreeChanges repoId={repoId} tabId={tabId} />
      )}

      <CommitBox repoId={repoId} state={state} />
    </section>
  );
}
