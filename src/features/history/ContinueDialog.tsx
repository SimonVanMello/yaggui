import { useEffect, useState } from 'react';

import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { useRepoState } from '../repo/useRepoState';
import { useHistoryDialogs, type HistoryDialog } from './historyDialogsStore';
import { continueOperation } from './historyOps';
import { useOperationDetail } from './useOperationDetail';
import styles from './HistoryDialogs.module.css';

type Props = Extract<HistoryDialog, { kind: 'continue' }>;

function Form({ repoId, prepared }: { repoId: number; prepared: string }) {
  const t = useT();
  const close = useHistoryDialogs((state) => state.close);
  const [message, setMessage] = useState(prepared);
  const [busy, setBusy] = useState(false);

  const submit = () => {
    if (busy || message.trim() === '') return;
    setBusy(true);
    // The message Git prepared is kept as is (`None`), so its trailers stay untouched.
    void continueOperation(repoId, message === prepared ? null : message).finally(close);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('history.continue.title')}
      description={t('history.continue.text')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" aria-disabled={busy || message.trim() === ''} onClick={submit}>
            {t('operation.continue')}
          </Button>
        </>
      }
    >
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className={styles.field}>
          <label htmlFor="continue-message">{t('history.continue.message')}</label>
          <textarea
            id="continue-message"
            className={styles.textarea}
            value={message}
            rows={6}
            onChange={(event) => {
              setMessage(event.target.value);
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
        </div>
      </form>
    </Dialog>
  );
}

/** Continue of the operation in progress, with the commit message Git prepared, editable. */
export function ContinueDialog({ repoId }: Props) {
  const state = useRepoState(repoId).data;
  const detail = useOperationDetail(repoId, state?.operation ?? null).data;
  const close = useHistoryDialogs((store) => store.close);
  const noMessage = detail?.message === null;
  // No prepared message (or an operation that creates no commit): nothing to edit.
  useEffect(() => {
    if (noMessage) void continueOperation(repoId, null).finally(close);
  }, [noMessage, repoId, close]);
  if (!detail || detail.message === null) return null;
  return <Form repoId={repoId} prepared={detail.message} />;
}
