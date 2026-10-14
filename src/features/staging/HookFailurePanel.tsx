import { useState } from 'react';

import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { hookOutputText, type HookFailure } from './commitUi';
import styles from './HookFailurePanel.module.css';

/**
 * A pre-commit / commit-msg hook rejected the commit (F-065): its output, scrollable, with a
 * button to copy it. Only a runaway output (megabytes) is cut in the middle, and says so.
 */
export function HookFailurePanel({
  failure,
  onDismiss,
}: {
  failure: HookFailure;
  onDismiss: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const output = hookOutputText(failure);

  const copy = () => {
    void navigator.clipboard.writeText(output).then(() => {
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    });
  };

  return (
    <div className={styles.panel} role="alert">
      <header className={styles.header}>
        <Icon name="error" className={styles.icon} />
        <b className={styles.title}>
          {failure.hook ? t('hook.failedNamed', { hook: failure.hook }) : t('hook.failed')}
        </b>
        {failure.exitCode !== null && (
          <span className={styles.exit}>{t('hook.exitCode', { code: failure.exitCode })}</span>
        )}
      </header>
      <p className={styles.message}>{t('hook.hint')}</p>
      {failure.truncated && <p className={styles.message}>{t('hook.truncated')}</p>}
      <pre className={styles.output} tabIndex={0} aria-label={t('hook.output')}>
        {output || t('hook.noOutput')}
      </pre>
      <div className={styles.actions}>
        <Button size="sm" onClick={copy}>
          <Icon name={copied ? 'check' : 'copy'} />
          {copied ? t('hook.copied') : t('hook.copy')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          {t('hook.dismiss')}
        </Button>
      </div>
    </div>
  );
}
