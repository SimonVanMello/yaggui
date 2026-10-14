import { useEffect, useRef, useState } from 'react';

import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import { toast } from '../../ui/toastStore';
import styles from './CopyShaButton.module.css';

const FEEDBACK_MS = 1500;

/**
 * The full SHA as a button: click copies it and swaps it for "Copied" for a moment. Both states
 * share one grid cell so the width and height never change.
 */
export function CopyShaButton({ sha }: { sha: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = () => {
    navigator.clipboard.writeText(sha).then(
      () => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          setCopied(false);
        }, FEEDBACK_MS);
      },
      () => {
        toast({ variant: 'error', title: t('sidebar.copyFailed') });
      },
    );
  };

  return (
    <>
      <button
        type="button"
        className={styles.sha}
        aria-label={t('graph.menu.copySha')}
        title={t('graph.menu.copySha')}
        data-copied={copied || undefined}
        onClick={copy}
      >
        <span className={styles.value}>{sha}</span>
        <span className={styles.done} aria-hidden="true">
          <Icon name="check" />
          {t('graph.detail.copied')}
        </span>
      </button>
      <span className={styles.status} role="status" aria-live="polite">
        {copied ? t('graph.detail.copied') : ''}
      </span>
    </>
  );
}
