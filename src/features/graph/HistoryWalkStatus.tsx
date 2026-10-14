import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { Spinner } from '../../ui/Spinner';
import styles from './HistoryWalkStatus.module.css';

/**
 * Shown while the backend still walks the history (first open without commit-graph, M5-4):
 * the rows on screen are final, more come and the count grows.
 */
export function HistoryWalkStatus({ rows }: { rows: number }) {
  const t = useT();
  const locale = useI18nStore((s) => s.locale);
  return (
    <div className={styles.status} role="status">
      <Spinner />
      {t('graph.walking', { count: rows, rows: new Intl.NumberFormat(locale).format(rows) })}
    </div>
  );
}
