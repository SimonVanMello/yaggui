import type { HTMLAttributes, KeyboardEvent, PointerEvent as ReactPointerEvent, Ref } from 'react';

import { repoColor } from '../../features/repo/repoColor';
import { repoDisplayName, useRepoSessions } from '../../features/repo/repoSessions';
import { changedFiles } from '../../features/repo/repoStatus';
import { selectRunningOp, useOpsStore } from '../../features/repo/opsStore';
import { useKnownRepos } from '../../features/repo/useKnownRepos';
import { useRepoState } from '../../features/repo/useRepoState';
import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { Tooltip } from '../../ui/Tooltip';
import type { ShellTab } from '../tabs/tabsStore';
import styles from './TabItem.module.css';

interface TabItemProps extends HTMLAttributes<HTMLDivElement> {
  tab: ShellTab;
  active: boolean;
  dragging: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onClose: () => void;
  /** Props and ref injected by wrapping Radix triggers (handlers are composed by Radix). */
  ref?: Ref<HTMLDivElement>;
}

/** One tab of the title bar, with its status indicators (F-004). */
export function TabItem({
  tab,
  active,
  dragging,
  onPointerDown,
  onKeyDown,
  onClose,
  ...rest
}: TabItemProps) {
  const t = useT();
  const session = useRepoSessions((state) =>
    tab.repoId === null ? undefined : state.sessions[tab.repoId],
  );
  const known = useKnownRepos().data?.find((repo) => repo.id === tab.repoId);
  const repoState = useRepoState(tab.repoId).data;
  const runningOp = useOpsStore(selectRunningOp(tab.repoId));

  const isWelcome = tab.repoId === null;
  const name = isWelcome ? t('tab.new') : (repoDisplayName(session, known) ?? t('tab.loading'));
  const path = session?.status === 'open' ? session.info.path : known?.path;
  const changes = repoState ? changedFiles(repoState) : 0;
  const conflicts = repoState?.dirty.conflicted ?? 0;
  const operation = repoState?.operation;
  const failed = session?.status === 'error';

  const status: string[] = [];
  if (runningOp) status.push(t('tab.status.running', { op: t(`op.${runningOp.kind}`) }));
  if (operation) status.push(t(`operation.${operation.kind}.short`));
  if (conflicts > 0) status.push(t('tab.status.conflicts', { count: conflicts }));
  if (changes > 0) status.push(t('tab.status.changes', { count: changes }));
  if (failed) status.push(t('tab.status.error'));

  const tooltip = isWelcome ? (
    t('tab.new')
  ) : (
    <span className={styles.tooltip}>
      <span className={styles.tooltipName}>{name}</span>
      {path && <span className={styles.tooltipPath}>{path}</span>}
      {status.length > 0 && <span>{status.join(' · ')}</span>}
    </span>
  );

  let leading;
  if (runningOp || session?.status === 'opening') leading = <Spinner />;
  else if (isWelcome) leading = null;
  else leading = <span className={styles.dot} style={{ background: repoColor(name) }} />;

  return (
    <Tooltip content={tooltip} side="bottom">
      <div
        {...rest}
        role="tab"
        id={`tab-${tab.id}`}
        aria-selected={active}
        aria-controls="tab-panel"
        aria-label={[name, ...status].join(', ')}
        tabIndex={active ? 0 : -1}
        data-tab-id={tab.id}
        data-dragging={dragging || undefined}
        className={styles.tab}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onMouseDown={(event) => {
          // Middle click closes the tab: prevent the browser autoscroll.
          if (event.button === 1) event.preventDefault();
        }}
        onAuxClick={(event) => {
          if (event.button === 1) onClose();
        }}
      >
        {leading}
        <span className={styles.label}>{name}</span>
        {(operation || conflicts > 0 || failed) && (
          <Icon
            name="warning"
            className={failed ? styles.errorIcon : styles.warningIcon}
            aria-hidden="true"
          />
        )}
        {changes > 0 && <span className={styles.badge}>{changes}</span>}
        <button
          type="button"
          tabIndex={-1}
          className={styles.close}
          aria-label={t('tab.close', { name })}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <Icon name="close" />
        </button>
      </div>
    </Tooltip>
  );
}
