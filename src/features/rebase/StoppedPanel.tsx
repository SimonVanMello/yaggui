import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useT } from '../../i18n/useT';
import type { YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { shortSha } from '../diff/format';
import { useRepoState } from '../repo/useRepoState';
import styles from './StoppedPanel.module.css';
import { useOperationDetail } from './rebaseOps';
import type { RebaseStop } from './rebaseStore';
import type { RebaseStep } from './useRebaseRun';

interface StoppedPanelProps {
  repoId: number;
  stop: RebaseStop;
  busy: RebaseStep | null;
  error: YagguiError | null;
  onContinue: () => void;
  onSkip: () => void;
  onAbort: () => void;
  onClose: () => void;
}

/**
 * The rebase halted on an `edit` step or on conflicts: says where, and offers the ways on.
 * It stays in the view as long as the rebase is in progress, and follows it to its next stop.
 */
export function StoppedPanel({
  repoId,
  stop,
  busy,
  error,
  onContinue,
  onSkip,
  onAbort,
  onClose,
}: StoppedPanelProps) {
  const t = useT();
  const state = useRepoState(repoId);
  const detail = useOperationDetail(repoId, state.dataUpdatedAt);
  const operation = state.data?.operation;
  const live = operation?.kind === 'rebase' ? operation : null;
  const step = live?.step ?? (stop.kind === 'edit' ? stop.step : null);
  const total = live?.total ?? (stop.kind === 'edit' ? stop.total : null);
  const unresolved = detail.data?.unresolved ?? 0;
  const conflicts = stop.kind === 'conflicts';
  const blocked = busy !== null || (conflicts && (detail.data === undefined || unresolved > 0));
  const position = step !== null && total !== null ? { step, total } : null;
  // Continued from the banner, the rebase halts on a later `edit`: show where it is now.
  const head = state.data?.head.kind === 'detached' ? state.data.head.oid : null;
  const replayed = detail.data?.labels.theirs.commit;
  const commit =
    stop.kind !== 'edit'
      ? null
      : head !== null && head !== stop.commit.sha && replayed
        ? { sha: head, summary: replayed.summary }
        : stop.commit;

  return (
    <div className={styles.wrap}>
      <section
        className={styles.panel}
        data-kind={stop.kind}
        aria-label={t('rebaseInteractive.stopped.label')}
      >
        <Icon name={conflicts ? 'warning' : 'info'} size="lg" className={styles.icon} />
        <div className={styles.body}>
          <h3 className={styles.title}>
            {commit
              ? position
                ? t('rebaseInteractive.stopped.edit', {
                    ...position,
                    sha: shortSha(commit.sha),
                    summary: commit.summary,
                  })
                : t('rebaseInteractive.stopped.editNoStep', {
                    sha: shortSha(commit.sha),
                    summary: commit.summary,
                  })
              : position
                ? t('rebaseInteractive.stopped.conflicts', position)
                : t('rebaseInteractive.stopped.conflictsNoStep')}
          </h3>
          <p className={styles.text}>
            {conflicts
              ? t('rebaseInteractive.stopped.conflictsHint')
              : t('rebaseInteractive.stopped.editHint')}
          </p>
          {conflicts && detail.data && (
            <p className={styles.count} role="status">
              {unresolved > 0
                ? t('rebaseInteractive.stopped.unresolved', { count: unresolved })
                : t('rebaseInteractive.stopped.resolved')}
            </p>
          )}
          {error && <ErrorPanel compact title={t('rebaseInteractive.stepFailed')} error={error} />}
          <div className={styles.actions}>
            <Button
              variant="primary"
              aria-disabled={blocked}
              onClick={blocked ? undefined : onContinue}
            >
              {busy === 'continue' && <Spinner />}
              {t('operation.continue')}
            </Button>
            {conflicts && (
              <Button aria-disabled={busy !== null} onClick={busy === null ? onSkip : undefined}>
                {busy === 'skip' && <Spinner />}
                {t('operation.skip')}
              </Button>
            )}
            <Button
              variant="danger"
              aria-disabled={busy !== null}
              onClick={busy === null ? onAbort : undefined}
            >
              {busy === 'abort' && <Spinner />}
              {t('operation.rebase.abort')}
            </Button>
            <Button variant="ghost" className={styles.close} onClick={onClose}>
              {t('rebaseInteractive.stopped.close')}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
