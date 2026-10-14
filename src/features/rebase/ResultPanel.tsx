import { useT } from '../../i18n/useT';
import type { InteractiveRebasePlan } from '../../ipc';
import { shortSha } from '../diff/format';
import styles from './ResultPanel.module.css';
import { summaryOf, type RebasePreview, type RebaseRow } from './rebaseModel';

interface ResultPanelProps {
  plan: InteractiveRebasePlan;
  rows: readonly RebaseRow[];
  result: RebasePreview;
}

/** The commits the branch will have once the rebase ran, newest on top. */
export function ResultPanel({ plan, rows, result }: ResultPanelProps) {
  const t = useT();
  const commits = [...result.commits].reverse();
  return (
    <section className={styles.panel} aria-label={t('rebaseInteractive.result.title')}>
      <h3 className={styles.title}>
        {t('rebaseInteractive.result.title')}
        <span className={styles.count}>
          {t('rebaseInteractive.result.count', { count: commits.length })}
        </span>
      </h3>
      {result.dropped.length > 0 && (
        <p className={styles.dropped}>
          {t('rebaseInteractive.result.dropped', { count: result.dropped.length })}
        </p>
      )}
      <ol className={styles.list}>
        {commits.map((commit) => {
          const edited =
            commit.messageRow !== null && (rows[commit.messageRow]?.message ?? null) !== null;
          return (
            <li key={commit.head.commit.sha} className={styles.item}>
              <span className={styles.summary} title={commit.message}>
                {summaryOf(commit.message) || t('rebaseInteractive.emptyMessage')}
              </span>
              <span className={styles.chips}>
                {commit.melded.length > 0 && (
                  <span className={styles.chip} data-tone="info">
                    {t('rebaseInteractive.result.melded', { count: commit.melded.length })}
                  </span>
                )}
                {edited && (
                  <span className={styles.chip} data-tone="accent">
                    {t('rebaseInteractive.result.edited')}
                  </span>
                )}
                {commit.stops && (
                  <span className={styles.chip} data-tone="warning">
                    {t('rebaseInteractive.result.stops')}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      <p className={styles.base} title={plan.base.summary}>
        {t('rebaseInteractive.result.base', {
          sha: shortSha(plan.base.sha),
          summary: plan.base.summary,
        })}
      </p>
    </section>
  );
}
