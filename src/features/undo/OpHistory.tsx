import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { JournalEntry } from '../../ipc';
import styles from './OpHistory.module.css';
import { blockMessage } from './undoLabels';
import { entryText, text } from './undoOps';
import { useOpHistory } from './undoQueries';

const formats = new Map<string, Intl.DateTimeFormat>();

/** "14:32:07" in the UI language. */
export function formatTime(at: number, locale: string): string {
  let format = formats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { timeStyle: 'medium' });
    formats.set(locale, format);
  }
  return format.format(at);
}

function Row({ entry, locale }: { entry: JournalEntry; locale: string }) {
  const t = useT();
  const label = entryText(entry);
  const blocked = entry.blocked ? text(blockMessage(entry.blocked)) : null;
  return (
    <li className={styles.row} data-undone={entry.undone} data-blocked={entry.blocked !== null}>
      <span className={styles.label} title={label}>
        {label}
      </span>
      <span className={styles.badges}>
        {entry.undone && <span className={styles.badge}>{t('undo.history.undone')}</span>}
        {blocked && (
          <span className={styles.badge} title={blocked}>
            {t('undo.history.blocked')}
          </span>
        )}
      </span>
      {entry.at !== null && (
        <time className={styles.time} dateTime={new Date(entry.at).toISOString()}>
          {formatTime(entry.at, locale)}
        </time>
      )}
    </li>
  );
}

/** Operations of the session, newest first, undone ones struck through (F-243). */
export function OpHistory({ repoId }: { repoId: number }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const history = useOpHistory(repoId, true).data;
  return (
    <section className={styles.history} aria-label={t('undo.history.title')}>
      <h2 className={styles.title}>{t('undo.history.title')}</h2>
      {history === undefined || history.length === 0 ? (
        <p className={styles.empty}>{history ? t('undo.history.empty') : ''}</p>
      ) : (
        <>
          <ul className={styles.list}>
            {history.map((entry) => (
              <Row key={entry.id} entry={entry} locale={locale} />
            ))}
          </ul>
          <p className={styles.hint}>{t('undo.history.hint')}</p>
        </>
      )}
    </section>
  );
}
