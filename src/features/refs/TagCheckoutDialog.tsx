import { useState, type SubmitEvent } from 'react';

import { useT } from '../../i18n/useT';
import type { YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { useRefDialogs, type RefDialog } from './refDialogsStore';
import styles from './RefDialogs.module.css';
import { checkout, createBranch } from './refOps';
import { RefNameField } from './RefNameField';
import { useRefNameCheck } from './useRefNameCheck';

type Props = Extract<RefDialog, { kind: 'tagCheckout' }>;

/**
 * Checkout of a tag (F-202): explains the detached HEAD, offers a branch from the tag (the
 * default) and keeps "continue in detached HEAD".
 */
export function TagCheckoutDialog({ repoId, name: tag, fullName }: Props) {
  const t = useT();
  const close = useRefDialogs((state) => state.close);
  // Not the tag's own name: a branch and a tag of the same name make the name ambiguous.
  const [name, setName] = useState(`${tag}-branch`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<YagguiError | null>(null);
  const check = useRefNameCheck(repoId, 'branch', name);
  const canSubmit = name !== '' && check.status !== 'invalid' && !busy;

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    // Created first, then checked out: local changes in the way get the usual dialog.
    void createBranch(repoId, name, { kind: 'ref', fullName }, false).then((result) => {
      if (result.ok) {
        close();
        void checkout(repoId, { kind: 'branch', name });
      } else if (result.handled) close();
      else {
        setError(result.error);
        setBusy(false);
      }
    });
  };

  const detached = () => {
    close();
    void checkout(repoId, { kind: 'detached', rev: tag });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('refs.tagCheckout.title', { name: tag })}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="secondary" onClick={detached} aria-disabled={busy}>
            {t('refs.tagCheckout.detached')}
          </Button>
          <Button variant="primary" type="submit" form="tag-checkout" aria-disabled={!canSubmit}>
            {t('refs.tagCheckout.create')}
          </Button>
        </>
      }
    >
      <form id="tag-checkout" className={styles.form} onSubmit={submit}>
        <div className={styles.warning}>
          <b>{t('refs.tagCheckout.detachedTitle')}</b>
          <span>{t('refs.tagCheckout.explain')}</span>
        </div>
        <div className={styles.field}>
          <span className={styles.choiceTitle}>{t('refs.tagCheckout.branch')}</span>
          <span className={styles.choiceHelp}>{t('refs.tagCheckout.branchHelp')}</span>
        </div>
        <RefNameField
          label={t('refs.tagCheckout.branchName')}
          value={name}
          onChange={(value) => {
            setName(value);
            setError(null);
          }}
          check={check}
          submitError={error}
        />
        <p className={styles.hint}>{t('refs.tagCheckout.detachedHelp')}</p>
      </form>
    </Dialog>
  );
}
