import { useI18nStore } from '../../i18n/i18n';
import { formatDuration } from '../../i18n/relativeTime';
import { useT } from '../../i18n/useT';
import type { CommandLogEntry, CommandStatus } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/Icon';
import { toast } from '../../ui/toastStore';
import styles from './CommandLogPanel.module.css';

const STATUS_ICON: Record<CommandStatus, IconName> = {
  success: 'check',
  failed: 'error',
  cancelled: 'close',
  spawnFailed: 'warning',
};

/** Shell-like rendering, quoting arguments that need it, for display and copy. */
export function formatCommand(args: readonly string[]): string {
  const quoted = args.map((arg) =>
    /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`,
  );
  return ['git', ...quoted].join(' ');
}

interface LogEntryRowProps {
  entry: CommandLogEntry;
  repoName: string | null;
  expanded: boolean;
  highlighted: boolean;
  onToggle: () => void;
}

export function LogEntryRow({
  entry,
  repoName,
  expanded,
  highlighted,
  onToggle,
}: LogEntryRowProps) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const command = formatCommand(entry.args);
  const time = new Date(entry.startedAt * 1000).toLocaleTimeString(locale, { hour12: false });
  const output = [entry.stdout, entry.stderr].filter(Boolean).join('\n');

  const copy = (text: string, message: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      toast({ variant: 'success', title: message, duration: 2000 });
    });
  };

  return (
    <div
      className={styles.entry}
      data-status={entry.status}
      data-highlighted={highlighted || undefined}
    >
      <button type="button" className={styles.summary} aria-expanded={expanded} onClick={onToggle}>
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} className={styles.chevron} />
        <Icon name={STATUS_ICON[entry.status]} className={styles.statusIcon} />
        <span className={styles.srOnly}>{t(`log.status.${entry.status}`)}</span>
        <code className={styles.command}>{command}</code>
        {repoName && <span className={styles.repo}>{repoName}</span>}
        {entry.exitCode !== null && entry.exitCode !== 0 && (
          <span className={styles.exit}>{t('log.exitCode', { code: entry.exitCode })}</span>
        )}
        <span className={styles.duration}>{formatDuration(entry.durationMs, locale)}</span>
        <span className={styles.time}>{time}</span>
      </button>
      {expanded && (
        <div className={styles.details}>
          <div className={styles.meta}>
            {entry.cwd && (
              <span>
                {t('log.cwd')} <code>{entry.cwd}</code>
              </span>
            )}
            <span className={styles.metaActions}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  copy(command, t('log.copied.command'));
                }}
              >
                <Icon name="copy" />
                {t('log.copyCommand')}
              </Button>
              {output && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    copy(output, t('log.copied.output'));
                  }}
                >
                  <Icon name="copy" />
                  {t('log.copyOutput')}
                </Button>
              )}
            </span>
          </div>
          {entry.stdout && <pre className={styles.output}>{entry.stdout}</pre>}
          {entry.stderr && (
            <pre className={styles.output} data-stream="stderr">
              {entry.stderr}
            </pre>
          )}
          {!output && <p className={styles.noOutput}>{t('log.noOutput')}</p>}
          {entry.truncated && <p className={styles.noOutput}>{t('log.truncated')}</p>}
        </div>
      )}
    </div>
  );
}
