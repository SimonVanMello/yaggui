import { useState, type SubmitEvent } from 'react';

import { useT } from '../../i18n/useT';
import type { YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { useRefDialogs, type RefDialog } from './refDialogsStore';
import styles from './RefDialogs.module.css';
import { createBranch } from './refOps';
import { RefNameField } from './RefNameField';
import { useRefNameCheck } from './useRefNameCheck';

type Props = Extract<RefDialog, { kind: 'createBranch' }>;

/** Create a branch from HEAD, a commit, a branch, a tag or a stash (F-100). */
export function CreateBranchDialog({ repoId, from, fromLabel }: Props) {
  const t = useT();
  const close = useRefDialogs((state) => state.close);
  const [name, setName] = useState('');
  const [checkout, setCheckout] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<YagguiError | null>(null);
  // `git stash branch` always checks the new branch out.
  const forced = from.kind === 'stash';
  const check = useRefNameCheck(repoId, 'branch', name);
  const invalid = check.status === 'invalid';
  const canSubmit = name !== '' && !invalid && !busy;

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    void createBranch(repoId, name, from, checkout || forced).then((result) => {
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
      title={t('refs.createBranch.title')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="create-branch" aria-disabled={!canSubmit}>
            {checkout || forced
              ? t('refs.createBranch.createCheckout')
              : t('refs.createBranch.create')}
          </Button>
        </>
      }
    >
      <form id="create-branch" className={styles.form} onSubmit={submit}>
        <div className={styles.from}>
          {t('refs.createBranch.from')} <code>{fromLabel}</code>
        </div>
        <RefNameField
          label={t('refs.createBranch.name')}
          value={name}
          onChange={(value) => {
            setName(value);
            setError(null);
          }}
          check={check}
          submitError={error}
          placeholder="feature/my-branch"
        />
        <label className={styles.check} data-disabled={forced}>
          <input
            type="checkbox"
            checked={checkout || forced}
            disabled={forced}
            onChange={(event) => {
              setCheckout(event.target.checked);
            }}
          />
          <span>{t('refs.createBranch.checkout')}</span>
        </label>
        {forced && <p className={styles.hint}>{t('refs.createBranch.stashHint')}</p>}
      </form>
    </Dialog>
  );
}
