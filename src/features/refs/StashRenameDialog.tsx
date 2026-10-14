import { useState, type SubmitEvent } from 'react';

import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import type { YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { useRefDialogs, type RefDialog } from './refDialogsStore';
import styles from './RefDialogs.module.css';
import { stashRename } from './refOps';

type Props = Extract<RefDialog, { kind: 'stashRename' }>;

export function StashRenameDialog({ repoId, stash, message: current }: Props) {
  const t = useT();
  const close = useRefDialogs((state) => state.close);
  const [message, setMessage] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<YagguiError | null>(null);
  const canSubmit = message.trim() !== '' && message !== current && !busy;

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    void stashRename(repoId, stash, message.trim()).then((result) => {
      if (result.ok || result.handled) close();
      else {
        setError(result.error);
        setBusy(false);
      }
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('refs.stashRename.title')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="rename-stash" aria-disabled={!canSubmit}>
            {t('refs.stashRename.confirm')}
          </Button>
        </>
      }
    >
      <form id="rename-stash" className={styles.form} onSubmit={submit}>
        <label className={styles.field}>
          <span>{t('refs.stashRename.message')}</span>
          <input
            className={styles.input}
            value={message}
            autoFocus
            onChange={(event) => {
              setMessage(event.target.value);
              setError(null);
            }}
          />
        </label>
        {error && (
          <p className={styles.status} data-state="invalid" role="alert">
            {localize(error.message)}
          </p>
        )}
        <p className={styles.hint}>{t('refs.stashRename.hint')}</p>
      </form>
    </Dialog>
  );
}
