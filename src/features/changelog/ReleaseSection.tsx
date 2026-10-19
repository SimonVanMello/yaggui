import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { ChangelogRelease } from '../../ipc';
import { ChangelogText } from './ChangelogText';
import { formatReleaseDate, groupEntries, releaseKey } from './changelog';
import styles from './ChangelogDialog.module.css';

/** One version: its header, then its entries grouped by kind. */
export function ReleaseSection({
  release,
  installed,
}: {
  release: ChangelogRelease;
  installed: boolean;
}) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const key = releaseKey(release);
  return (
    <section
      className={styles.release}
      data-installed={installed || undefined}
      aria-labelledby={`changelog-${key}`}
    >
      <header className={styles.releaseHeader}>
        <h3 id={`changelog-${key}`} className={styles.version}>
          {release.version ?? t('changelog.unreleased')}
        </h3>
        {installed && <span className={styles.badge}>{t('changelog.installed')}</span>}
        {release.date && (
          <time className={styles.date} dateTime={release.date}>
            {formatReleaseDate(release.date, locale)}
          </time>
        )}
      </header>
      {groupEntries(release.entries).map((group) => (
        <div key={group.kind} className={styles.group}>
          <h4 className={styles.kind} data-kind={group.kind}>
            {t(`changelog.kind.${group.kind}`)}
          </h4>
          <ul className={styles.entries}>
            {group.entries.map((entry, index) => (
              <li key={index} className={styles.entry}>
                <ChangelogText text={entry.text} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
