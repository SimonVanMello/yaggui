import { useId } from 'react';

import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { useNow } from '../../ui/useNow';
import type { JournalEntry } from '../../ipc';
import styles from './OpHistory.module.css';
import { formatWhen, groupHistory, isUnrestorable } from './undoHistory';
import { blockMessage } from './undoLabels';
import { entryText, text } from './undoOps';
import { useOpHistory } from './undoQueries';

function Row({ entry, locale, now }: { entry: JournalEntry; locale: string; now: number }) {
  const t = useT();
  const reasonId = useId();
  const label = entryText(entry);
  const reason = entry.blocked ? text(blockMessage(entry.blocked)) : null;
  return (
    <li
      className={styles.row}
      data-undone={entry.undone}
      data-blocked={entry.blocked !== null}
      title={reason ? t('undo.toolbar.blocked', { op: label, reason }) : label}
      aria-describedby={reason ? reasonId : undefined}
    >
      <span className={styles.label}>{label}</span>
      <span className={styles.badges}>
        {entry.undone && <span className={styles.badge}>{t('undo.history.undone')}</span>}
        {entry.blocked && (
          <span className={styles.badge} data-kind="blocked">
            {t(
              isUnrestorable(entry.blocked) ? 'undo.history.unrestorable' : 'undo.history.blocked',
            )}
          </span>
        )}
      </span>
      {entry.at !== null && (
        <time className={styles.time} dateTime={new Date(entry.at).toISOString()}>
          {formatWhen(entry.at, now, locale)}
        </time>
      )}
      {reason && (
        <span id={reasonId} className={styles.reason}>
          {reason}
        </span>
      )}
    </li>
  );
}

/**
 * Operations of this session, then those of earlier sessions reloaded from `yaggui.db`
 * (F-243, F-244), newest first. Read only: undo always acts on the newest entry. At most
 * `JOURNAL_MAX_ENTRIES` (100) rows, so the list is not virtualized.
 */
export function OpHistory({ repoId }: { repoId: number }) {
  const t = useT();
  const earlierId = useId();
  const locale = useI18nStore((state) => state.locale);
  const history = useOpHistory(repoId, true).data;
  const now = useNow();
  if (history === undefined || history.length === 0) {
    return (
      <section className={styles.history} aria-label={t('undo.history.title')}>
        <h2 className={styles.title}>{t('undo.history.title')}</h2>
        <p className={styles.empty}>{history ? t('undo.history.empty') : ''}</p>
      </section>
    );
  }
  const { current, earlier } = groupHistory(history);
  const rows = (entries: JournalEntry[]) =>
    entries.map((entry) => <Row key={entry.id} entry={entry} locale={locale} now={now} />);
  return (
    <section className={styles.history} aria-label={t('undo.history.title')}>
      <h2 className={styles.title}>{t('undo.history.title')}</h2>
      <div className={styles.scroll}>
        {current.length > 0 ? (
          <ul className={styles.list} aria-label={t('undo.history.current')}>
            {rows(current)}
          </ul>
        ) : (
          <p className={styles.empty}>{t('undo.history.empty')}</p>
        )}
        {earlier.length > 0 && (
          <>
            <h3 id={earlierId} className={styles.separator}>
              {t('undo.history.earlier')}
            </h3>
            <ul className={styles.list} aria-labelledby={earlierId}>
              {rows(earlier)}
            </ul>
          </>
        )}
      </div>
      <p className={styles.hint}>{t('undo.history.hint')}</p>
    </section>
  );
}
