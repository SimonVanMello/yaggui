import { execShellAction } from '../../app/shellActions';
import { useShellStore } from '../../app/shellStore';
import { usePreferences } from '../../app/usePreferences';
import { useI18nStore } from '../../i18n/i18n';
import { formatRelativeTime } from '../../i18n/relativeTime';
import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import { Tooltip } from '../../ui/Tooltip';
import { useNow } from '../../ui/useNow';
import { selectRunningOp, useOpsStore } from '../repo/opsStore';
import { useRepoRefs } from '../sidebar/useRepoRefs';
import { fetchRemotes } from '../toolbar/fetchRemotes';
import styles from './StatusBar.module.css';
import { isOffline, syncLabel } from './syncLabel';
import { useLastFetch } from './useLastFetch';

/**
 * "Synced 2 minutes ago" for the active repository: its last fetch (`FETCH_HEAD`, terminal
 * fetches included), "Offline" while its last network operation could not reach the remote.
 * Clicking it fetches, like the toolbar button.
 */
export function SyncStatus({ repoId }: { repoId: number }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const now = useNow();
  const lastFetch = useLastFetch(repoId);
  const offline = useOpsStore((state) => isOffline(state.lastNetwork[repoId]));
  const busy = useOpsStore((state) => selectRunningOp(repoId)(state) !== undefined);
  const { autoFetch, autoFetchMinutes } = usePreferences();
  const remotes = fetchRemotes(useRepoRefs(repoId).data?.remotes);

  if (lastFetch.data === undefined) return null;
  const at = lastFetch.data;
  const label = syncLabel(at, offline, (seconds) => formatRelativeTime(seconds, now, locale));
  const date =
    at === null
      ? t('status.sync.lastFetchNever')
      : t('status.sync.lastFetch', {
          date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
            at * 1000,
          ),
        });

  const details = (
    <span className={styles.syncTip}>
      <span>{date}</span>
      <span>
        {remotes.length === 0
          ? t('status.sync.noRemote')
          : t('status.sync.remotes', { remotes: remotes.join(', ') })}
      </span>
      <span>
        {autoFetch
          ? t('network.fetch.auto', { minutes: autoFetchMinutes })
          : t('network.fetch.autoOff')}
      </span>
      {offline && <span className={styles.syncWarning}>{t('status.sync.offlineHint')}</span>}
      <span className={styles.muted}>{busy ? t('status.sync.busy') : t('status.sync.fetch')}</span>
      <button
        type="button"
        className={styles.link}
        onClick={() => {
          useShellStore.getState().setPreferencesOpen(true, 'sync');
        }}
      >
        {t('status.sync.preferences')}
      </button>
    </span>
  );

  return (
    <Tooltip content={details} side="top" interactive>
      <button
        type="button"
        className={styles.sync}
        data-tone={label.tone}
        // Not `disabled`: the tooltip must still explain why while the operation runs.
        aria-disabled={busy}
        onClick={() => {
          if (!busy) execShellAction('fetch');
        }}
      >
        <Icon name={offline ? 'warning' : 'cloud'} />
        {t(label.key, label.params)}
      </button>
    </Tooltip>
  );
}
