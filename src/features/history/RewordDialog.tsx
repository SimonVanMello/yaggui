import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { YagguiIpcError, ipc, unwrap } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Spinner } from '../../ui/Spinner';
import refStyles from '../refs/RefDialogs.module.css';
import { shortOid } from '../repo/repoStatus';
import { useHistoryDialogs, type HistoryDialog } from './historyDialogsStore';
import { rewordCommit } from './historyOps';
import styles from './HistoryDialogs.module.css';

type Props = Extract<HistoryDialog, { kind: 'reword' }>;

/**
 * Edits the message of a commit of the current branch: HEAD is amended without its staged
 * changes, an older commit is rewritten by a rebase of the commits after it.
 */
export function RewordDialog({ repoId, sha, head }: Props) {
  const t = useT();
  const close = useHistoryDialogs((state) => state.close);
  const detail = useQuery({
    queryKey: ['commit-detail', repoId, sha],
    queryFn: () => unwrap(ipc.commands.commitDetail(repoId, sha)),
    staleTime: Infinity,
  });
  // `null` until edited: the field shows the commit's message once it is read.
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const original = detail.data?.message ?? '';
  const message = draft ?? original;
  const empty = (message.trim().split('\n')[0] ?? '').trim() === '';
  const unchanged = message.trimEnd() === original.trimEnd();
  const disabled = busy || !detail.data || empty || unchanged;

  const submit = () => {
    if (disabled) return;
    setBusy(true);
    void rewordCommit(repoId, sha, message).finally(close);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('history.reword.title', { sha: shortOid(sha) })}
      description={t(head ? 'history.reword.headText' : 'history.reword.rebaseText')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" aria-disabled={disabled} onClick={submit}>
            {t('history.reword.confirm')}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        {detail.isPending && (
          <p className={styles.summary} role="status">
            <Spinner /> {t('history.reword.loading')}
          </p>
        )}
        {detail.error && (
          <p className={styles.lostTitle} role="alert">
            {detail.error instanceof YagguiIpcError
              ? localize(detail.error.error.message)
              : detail.error.message}
          </p>
        )}
        {detail.data && (
          <label className={styles.field}>
            {t('history.reword.label')}
            <textarea
              className={styles.textarea}
              rows={8}
              value={message}
              spellCheck
              autoFocus
              aria-invalid={empty || undefined}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </label>
        )}
        <code className={refStyles.command}>
          {head
            ? 'git commit --amend --only'
            : `git rebase --interactive ${shortOid(detail.data?.parents[0] ?? sha)}`}
        </code>
      </div>
    </Dialog>
  );
}
