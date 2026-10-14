import { useState } from 'react';

import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import type { YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { useRefDialogs, type RefDialog } from './refDialogsStore';
import styles from './RefDialogs.module.css';
import { deleteBranch } from './refOps';

type Props = Extract<RefDialog, { kind: 'deleteBranch' }>;

/**
 * Deletes a local branch (F-101), and optionally its remote counterpart. Git refuses an
 * unmerged branch: the dialog then warns about the commits at stake and offers to force.
 */
export function DeleteBranchDialog({ repoId, name, upstream }: Props) {
  const t = useT();
  const close = useRefDialogs((state) => state.close);
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [unmerged, setUnmerged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<YagguiError | null>(null);
  const remote = upstream?.split('/')[0] ?? null;
  const remoteBranch = upstream && remote ? upstream.slice(remote.length + 1) : null;

  const run = (force: boolean) => {
    setBusy(true);
    setError(null);
    void deleteBranch(repoId, { name, force, deleteRemote }).then((result) => {
      if (result.ok || result.handled) {
        close();
        return;
      }
      setBusy(false);
      if (result.error.code === 'branchNotMerged') setUnmerged(true);
      else setError(result.error);
    });
  };

  const flag = unmerged ? '-D' : '-d';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('refs.delete.title', { name })}
      description={t('refs.delete.description')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) run(unmerged);
            }}
          >
            {unmerged ? t('refs.delete.force') : t('refs.delete.confirm')}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        {unmerged && (
          <div className={styles.warning} role="alert">
            <b>{t('refs.delete.notMergedTitle', { name })}</b>
            <span>{t('refs.delete.notMerged', { name })}</span>
          </div>
        )}
        {upstream && remoteBranch && (
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={deleteRemote}
              onChange={(event) => {
                setDeleteRemote(event.target.checked);
              }}
            />
            <span>{t('refs.delete.remote', { upstream })}</span>
          </label>
        )}
        {error && (
          <p className={styles.status} data-state="invalid" role="alert">
            {localize(error.message)}
          </p>
        )}
        <code className={styles.command}>
          {`git branch ${flag} ${name}`}
          {deleteRemote && remote && remoteBranch
            ? `\ngit push ${remote} --delete ${remoteBranch}`
            : ''}
        </code>
      </div>
    </Dialog>
  );
}
