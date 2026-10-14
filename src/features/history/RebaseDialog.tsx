import { useState } from 'react';

import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import refStyles from '../refs/RefDialogs.module.css';
import { useRepoRefs } from '../sidebar/useRepoRefs';
import { BranchSelect, branchOptions } from './BranchSelect';
import { useHistoryDialogs, type HistoryDialog } from './historyDialogsStore';
import { currentBranchOf, rebaseBranch, rebaseCommand } from './historyOps';
import styles from './HistoryDialogs.module.css';

type Props = Extract<HistoryDialog, { kind: 'rebase' }>;

/** Rebase of a branch onto another one, with the branch to rebase onto picked by keyboard. */
export function RebaseDialog({ repoId, branch: initialBranch, onto: initialOnto }: Props) {
  const t = useT();
  const close = useHistoryDialogs((state) => state.close);
  const refs = useRepoRefs(repoId).data;
  const branch = initialBranch ?? currentBranchOf(repoId);
  const [onto, setOnto] = useState(initialOnto ?? '');
  const [busy, setBusy] = useState(false);

  const submit = () => {
    if (busy || onto === '') return;
    setBusy(true);
    void rebaseBranch(repoId, { branch: initialBranch, onto }, true).finally(close);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('history.rebase.title', { branch: branch ?? 'HEAD', onto: onto || '…' })}
      description={t('history.rebase.confirmText', { branch: branch ?? 'HEAD', onto: onto || '…' })}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" aria-disabled={busy || onto === ''} onClick={submit}>
            {t('history.rebase.confirm')}
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
        {initialOnto === null && (
          <BranchSelect
            label={t('history.rebase.onto')}
            value={onto}
            options={branchOptions(refs, [branch], true)}
            onChange={setOnto}
          />
        )}
        <code className={refStyles.command}>
          {rebaseCommand({ branch: initialBranch, onto: onto || '<branch>' })}
        </code>
      </form>
    </Dialog>
  );
}
