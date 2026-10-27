import { useShellStore } from '../../app/shellStore';
import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { useAppInfo } from '../../app/useAppInfo';
import { useI18nStore } from '../../i18n/i18n';
import { formatRelativeTime } from '../../i18n/relativeTime';
import { useT } from '../../i18n/useT';
import { ipc } from '../../ipc';
import { Icon, type IconName } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { Tooltip } from '../../ui/Tooltip';
import { useNow } from '../../ui/useNow';
import { useCommandLog } from '../command-log/useCommandLog';
import { useShortcut } from '../keybindings/registry';
import { selectRunningOp, useOpsStore } from '../repo/opsStore';
import styles from './StatusBar.module.css';

const OUTCOME_ICON: Record<'success' | 'failed' | 'cancelled', IconName> = {
  success: 'check',
  failed: 'error',
  cancelled: 'close',
};

/** `12,3 Mo` / `2,1 Mo/s`: locale units from `Intl`, no translation needed. */
export function formatBytes(bytes: number, locale: string, perSecond = false): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const unit = units[index] ?? 'byte';
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: perSecond ? `${unit}-per-second` : unit,
    unitDisplay: 'short',
    maximumFractionDigits: index === 0 ? 0 : 1,
  }).format(value);
}

function OperationStatus({ repoId }: { repoId: number }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const now = useNow();
  const running = useOpsStore(selectRunningOp(repoId));
  const last = useOpsStore((state) => state.lastFinished[repoId]);

  if (running) {
    const label = t(`op.${running.kind}`);
    return (
      <span className={styles.operation} role="status">
        <Spinner />
        <span>
          {running.cancelRequested ? t('status.cancelling', { op: label }) : label}
          {running.phase && <span className={styles.muted}> · {running.phase}</span>}
          {running.percent !== null && <span className={styles.muted}> {running.percent} %</span>}
          {running.bytes !== null && (
            <span className={styles.muted}>
              {' · '}
              {formatBytes(running.bytes, locale)}
              {running.bytesPerSec !== null &&
                ` · ${formatBytes(running.bytesPerSec, locale, true)}`}
            </span>
          )}
        </span>
        {running.percent !== null && (
          <span className={styles.progress} aria-hidden="true">
            <i style={{ width: `${String(running.percent)}%` }} />
          </span>
        )}
        {running.cancellable && !running.cancelRequested && (
          <button
            type="button"
            className={styles.link}
            onClick={() => {
              useOpsStore.getState().cancelRequested(running.opId);
              void ipc.commands.cancelOp(running.opId);
            }}
          >
            {t('common.cancel')}
          </button>
        )}
      </span>
    );
  }

  if (!last) return null;
  const params = { op: t(`op.${last.kind}`) };
  const text = last.note
    ? t(`status.op.${last.note}`, params)
    : {
        success: t('status.op.success', params),
        failed: t('status.op.failed', params),
        cancelled: t('status.op.cancelled', params),
      }[last.outcome];
  return (
    <span className={styles.operation} data-outcome={last.outcome} role="status">
      <Icon name={OUTCOME_ICON[last.outcome]} className={styles.outcomeIcon} />
      {text}
      <span className={styles.muted}>
        · {formatRelativeTime(last.finishedAt / 1000, now, locale)}
      </span>
    </span>
  );
}

/** Bottom bar: current operation, app and git versions, the command log toggle (F-300). */
export function StatusBar() {
  const t = useT();
  const repoId = useTabsStore((state) => selectActiveTab(state).repoId);
  const appInfo = useAppInfo();
  const logOpen = useShellStore((state) => state.logOpen);
  const logShortcut = useShortcut('view.log');
  const log = useCommandLog();
  const count = log.data?.length;

  let git = null;
  if (appInfo.data) {
    const { gitVersion, gitSupported, minGitVersion } = appInfo.data;
    git = gitVersion ? (
      <Tooltip
        content={gitSupported ? t('status.git.ok') : t('status.git.old', { min: minGitVersion })}
      >
        <span className={styles.item} data-tone={gitSupported ? undefined : 'warning'} tabIndex={0}>
          {!gitSupported && <Icon name="warning" />}
          git {gitVersion}
        </span>
      </Tooltip>
    ) : (
      <span className={styles.item} data-tone="danger">
        <Icon name="error" />
        {t('status.git.missing')}
      </span>
    );
  }

  return (
    <footer className={styles.statusbar}>
      <div className={styles.start}>{repoId !== null && <OperationStatus repoId={repoId} />}</div>
      <div className={styles.end}>
        {appInfo.data && (
          <Tooltip content={t('changelog.open')} side="top">
            <button
              type="button"
              className={styles.version}
              onClick={() => {
                useShellStore.getState().setChangelogOpen(true);
              }}
            >
              {t('status.version', { version: appInfo.data.appVersion })}
            </button>
          </Tooltip>
        )}
        {git}
        <Tooltip
          content={logOpen ? t('log.hide') : t('log.show')}
          shortcut={logShortcut}
          side="top"
        >
          <button
            type="button"
            className={styles.logToggle}
            aria-expanded={logOpen}
            aria-controls="command-log"
            onClick={() => {
              useShellStore.getState().toggleLog();
            }}
          >
            <Icon name="log" />
            {count === undefined ? t('log.title') : t('log.titleCount', { count })}
            <Icon name={logOpen ? 'chevronDown' : 'chevronUp'} />
          </button>
        </Tooltip>
      </div>
    </footer>
  );
}
