import type { MessageKey } from '../../i18n/i18n';
import pillStyles from '../graph/RefPills.module.css';
import type { BisectRowMark } from './bisectModel';
import styles from './BisectMarkPill.module.css';

export const BISECT_MARK_LABELS: Record<BisectRowMark, MessageKey> = {
  good: 'bisect.row.good',
  bad: 'bisect.row.bad',
  skip: 'bisect.row.skip',
  current: 'bisect.row.current',
  found: 'bisect.row.found',
};

/** Bisect mark at the start of a graph row (F-263); `label` is translated by the graph. */
export function BisectMarkPill({ mark, label }: { mark: BisectRowMark; label: string }) {
  return (
    <span
      className={`${pillStyles.pill ?? ''} ${styles.mark ?? ''}`}
      data-mark={mark}
      data-testid="bisect-mark"
    >
      {label}
    </span>
  );
}
