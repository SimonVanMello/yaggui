import { useState } from 'react';

import { localize, resolveErrorAction } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import type { YagguiError, RepoState } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Tooltip } from '../../ui/Tooltip';
import { abortOperation, showConflicts, skipOperation, startContinue } from '../history/historyOps';
import { useOperationDetail } from '../history/useOperationDetail';
import { shortOid } from './repoStatus';
import styles from './RepoBanners.module.css';

function OperationBanner({
  repoId,
  operation,
  conflicted,
}: {
  repoId: number;
  operation: NonNullable<RepoState['operation']>;
  conflicted: number;
}) {
  const t = useT();
  const detail = useOperationDetail(repoId, operation).data;
  const [busy, setBusy] = useState(false);
  const run = (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void work().finally(() => {
      setBusy(false);
    });
  };

  const step =
    operation.kind === 'rebase' && operation.step !== null && operation.total !== null
      ? { step: operation.step, total: operation.total }
      : null;
  // "Rebase 3/7" when the progress is known, else the plain name of the operation.
  const title = step
    ? t('operation.progress', { operation: t('operation.rebase.name'), ...step })
    : t(`operation.${operation.kind}.long`);

  const oursLabel = detail?.labels.ours;
  const ours = oursLabel?.branch ?? null;
  const theirsLabel = detail?.labels.theirs;
  const theirs =
    theirsLabel?.branch ?? (theirsLabel?.commit ? shortOid(theirsLabel.commit.sha) : null);
  let summary: string | null = null;
  if (operation.kind === 'rebase') {
    summary = operation.headName
      ? t('operation.summary.rebase', {
          branch: operation.headName,
          // An interactive rebase is often onto a commit no branch points to: its SHA.
          onto: ours ?? (oursLabel?.commit ? shortOid(oursLabel.commit.sha) : 'HEAD'),
        })
      : null;
  } else if (operation.kind === 'merge' && theirs) {
    summary = t(operation.squash ? 'operation.summary.squash' : 'operation.summary.merge', {
      source: theirs,
      target: ours ?? 'HEAD',
    });
  } else if ((operation.kind === 'cherryPick' || operation.kind === 'revert') && theirs) {
    summary = t(`operation.summary.${operation.kind}`, { commit: theirs, target: ours ?? 'HEAD' });
  }

  const unresolved = detail?.unresolved ?? conflicted;
  const canContinue = detail?.canContinue ?? false;
  const continueButton = (
    <Button
      size="sm"
      variant="primary"
      aria-disabled={busy || !canContinue}
      onClick={() => {
        if (canContinue) run(() => startContinue(repoId));
      }}
    >
      {t('operation.continue')}
    </Button>
  );

  return (
    <div
      className={styles.banner}
      data-tone="warning"
      role="status"
      aria-label={t('operation.label')}
    >
      <Icon name="warning" size="md" className={styles.icon} />
      <span className={styles.text}>
        <b>{title}</b>
        {step && (
          <span
            className={styles.progress}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={step.total}
            aria-valuenow={step.step}
            aria-label={t('operation.step', step)}
          >
            <i style={{ width: `${String((step.step / step.total) * 100)}%` }} />
          </span>
        )}
        {summary && <span className={styles.muted}>{summary}</span>}
        {unresolved > 0 && (
          <span className={styles.conflicts}>
            {t('operation.conflicts', { count: unresolved })}
          </span>
        )}
      </span>
      <span className={styles.actions}>
        {unresolved > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              showConflicts(repoId);
            }}
          >
            {t('history.conflicts.show')}
          </Button>
        )}
        {operation.kind !== 'bisect' &&
          (canContinue ? (
            continueButton
          ) : (
            <Tooltip content={t('operation.continueBlocked', { count: unresolved })}>
              {continueButton}
            </Tooltip>
          ))}
        {detail?.canSkip && (
          <Button
            size="sm"
            variant="secondary"
            aria-disabled={busy}
            onClick={() => {
              run(() => skipOperation(repoId));
            }}
          >
            {t('operation.skip')}
          </Button>
        )}
        <Button
          size="sm"
          variant="danger"
          aria-disabled={busy}
          onClick={() => {
            run(() => abortOperation(repoId));
          }}
        >
          {t(`operation.${operation.kind}.abort`)}
        </Button>
      </span>
    </div>
  );
}

/**
 * Persistent banners above the graph: operation in progress (spec §6.5, always say where
 * we are), a leftover `index.lock` with its fix, and a repository the watcher cannot follow.
 */
export function RepoBanners({
  repoId,
  state,
  watchError,
  onRefresh,
}: {
  repoId: number;
  state: RepoState;
  /** Set when the backend could not watch the repository: no automatic refresh. */
  watchError: YagguiError | null;
  onRefresh: () => void;
}) {
  const t = useT();
  const { operation, indexLock, dirty } = state;

  const operationBanner = operation && (
    <OperationBanner repoId={repoId} operation={operation} conflicted={dirty.conflicted} />
  );

  let lockBanner = null;
  if (indexLock) {
    const action = resolveErrorAction(
      { kind: 'removeIndexLock', repoId, path: indexLock.path },
      {},
    );
    lockBanner = (
      <div className={styles.banner} data-tone={indexLock.stale ? 'danger' : 'info'} role="status">
        <Icon name="lock" size="md" className={styles.icon} />
        <span className={styles.text}>
          <b>{indexLock.stale ? t('indexLock.stale') : t('indexLock.busy')}</b>
          <span className={styles.muted}>
            {t('indexLock.age', { seconds: Math.round(indexLock.ageSecs) })}
          </span>
        </span>
        {indexLock.stale && action && (
          <span className={styles.actions}>
            <Button size="sm" variant="secondary" onClick={action.run}>
              {action.label}
            </Button>
          </span>
        )}
      </div>
    );
  }

  const watchBanner = watchError && (
    <div className={styles.banner} data-tone="info" data-subtle role="status">
      <Icon name="info" className={styles.icon} />
      <span className={styles.text}>
        <b>{t('watch.unavailable')}</b>
        <span className={styles.muted} title={watchError.detail ?? undefined}>
          {localize(watchError.message)}
        </span>
      </span>
      <span className={styles.actions}>
        <Button size="sm" variant="ghost" onClick={onRefresh}>
          <Icon name="retry" />
          {t('watch.refresh')}
        </Button>
      </span>
    </div>
  );

  return (
    <>
      {operationBanner}
      {lockBanner}
      {watchBanner}
    </>
  );
}
