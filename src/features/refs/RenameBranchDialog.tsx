import { useState, type SubmitEvent } from 'react';

import { useT } from '../../i18n/useT';
import type { YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { useRefDialogs, type RefDialog } from './refDialogsStore';
import styles from './RefDialogs.module.css';
import { renameBranch } from './refOps';
import { RefNameField } from './RefNameField';
import { useRefNameCheck } from './useRefNameCheck';

type Props = Extract<RefDialog, { kind: 'renameBranch' }>;

export function RenameBranchDialog({ repoId, name: current }: Props) {
  const t = useT();
  const close = useRefDialogs((state) => state.close);
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<YagguiError | null>(null);
  const unchanged = name === current;
  const check = useRefNameCheck(repoId, 'branch', name, unchanged);
  const canSubmit = name !== '' && !unchanged && check.status !== 'invalid' && !busy;

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    void renameBranch(repoId, current, name).then((result) => {
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
      title={t('refs.rename.title', { name: current })}
      description={t('refs.rename.description')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="rename-branch" aria-disabled={!canSubmit}>
            {t('refs.rename.confirm')}
          </Button>
        </>
      }
    >
      <form id="rename-branch" className={styles.form} onSubmit={submit}>
        <RefNameField
          label={t('refs.rename.name')}
          value={name}
          onChange={(value) => {
            setName(value);
            setError(null);
          }}
          check={check}
          submitError={error}
        />
      </form>
    </Dialog>
  );
}
