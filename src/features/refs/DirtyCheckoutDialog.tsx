import { useMemo, useState } from 'react';

import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { useChangedFiles } from '../diff/diffQueries';
import { useRefDialogs, type RefDialog } from './refDialogsStore';
import styles from './RefDialogs.module.css';
import { checkout } from './refOps';

type Props = Extract<RefDialog, { kind: 'dirtyCheckout' }>;

const MAX_LISTED = 100;

/** Local changes in the way of a checkout (F-102): what is at stake, and the ways out. */
export function DirtyCheckoutDialog({ repoId, target, label, paths, canCarry }: Props) {
  const t = useT();
  const close = useRefDialogs((state) => state.close);
  const [busy, setBusy] = useState(false);
  const staged = useChangedFiles(repoId, { kind: 'staged' }).data;
  const unstaged = useChangedFiles(repoId, { kind: 'unstaged' }).data;
  const files = useMemo(() => {
    const all = new Set([...(staged?.files ?? []), ...(unstaged?.files ?? [])].map((f) => f.path));
    return [...all].sort();
  }, [staged, unstaged]);
  const blocking = useMemo(() => new Set(paths), [paths]);

  const proceed = (mode: 'stashAndPop' | 'carry') => {
    if (busy) return;
    setBusy(true);
    close();
    void checkout(repoId, target, mode);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('refs.dirty.title', { name: label })}
      description={t('refs.dirty.description')}
      footer={
        <Button variant="ghost" onClick={close}>
          {t('common.cancel')}
        </Button>
      }
    >
      <div className={styles.form}>
        <ul className={styles.files} aria-label={t('refs.dirty.files')}>
          {files.slice(0, MAX_LISTED).map((path) => (
            <li key={path} title={path}>
              {blocking.has(path) ? `! ${path}` : path}
            </li>
          ))}
          {files.length > MAX_LISTED && (
            <li>{t('confirm.more', { count: files.length - MAX_LISTED })}</li>
          )}
        </ul>
        {paths.length > 0 && (
          <p className={styles.hint}>{t('refs.dirty.blocking', { count: paths.length })}</p>
        )}
        <div className={styles.choices}>
          <button
            type="button"
            className={styles.choice}
            autoFocus
            onClick={() => {
              proceed('stashAndPop');
            }}
          >
            <span className={styles.choiceTitle}>{t('refs.dirty.stash')}</span>
            <span className={styles.choiceHelp}>{t('refs.dirty.stashHelp')}</span>
          </button>
          <button
            type="button"
            className={styles.choice}
            aria-disabled={!canCarry}
            onClick={() => {
              if (canCarry) proceed('carry');
            }}
          >
            <span className={styles.choiceTitle}>{t('refs.dirty.carry')}</span>
            <span className={styles.choiceHelp}>
              {canCarry
                ? t('refs.dirty.carryHelp')
                : t('refs.dirty.carryDisabled', { name: label })}
            </span>
          </button>
        </div>
      </div>
    </Dialog>
  );
}
