import { useI18nStore } from '../../i18n/i18n';
import { formatRelativeTime } from '../../i18n/relativeTime';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/Icon';
import type { ToastVariant } from '../../ui/toastStore';
import styles from './ActivityCenter.module.css';
import type { ActivityEntry, ActivityTarget } from './activityStore';

const ICONS: Record<ToastVariant, IconName> = {
  info: 'info',
  success: 'check',
  warning: 'warning',
  error: 'error',
};

interface ActivityEntryRowProps {
  entry: ActivityEntry;
  target: ActivityTarget;
  now: number;
  onOpen: () => void;
  onAction: () => void;
}

/** One notification of the Activity center: tone, message, repository and time. */
export function ActivityEntryRow({ entry, target, now, onOpen, onAction }: ActivityEntryRowProps) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const when = formatRelativeTime(entry.at / 1000, now, locale);
  const hint =
    target.kind === 'log'
      ? t('activity.openLog')
      : target.kind === 'tab' && entry.repoName !== null
        ? t('activity.openTab', { repo: entry.repoName })
        : undefined;
  const full = entry.description ? `${entry.title}\n${entry.description}` : entry.title;

  return (
    <li className={styles.row} data-tone={entry.tone}>
      <button
        type="button"
        className={styles.entry}
        data-activity-entry=""
        data-target={target.kind}
        title={hint ? `${full}\n\n${hint}` : full}
        onClick={onOpen}
      >
        <Icon name={ICONS[entry.tone]} className={styles.icon} />
        <span className={styles.srOnly}>{t(`activity.tone.${entry.tone}`)}</span>
        <span className={styles.text}>
          <span className={styles.message}>{entry.title}</span>
          <span className={styles.meta}>
            {entry.repoName === null ? when : `${entry.repoName} · ${when}`}
          </span>
        </span>
      </button>
      {entry.action && (
        <Button size="sm" variant="ghost" className={styles.action} onClick={onAction}>
          {entry.action.label}
        </Button>
      )}
    </li>
  );
}
