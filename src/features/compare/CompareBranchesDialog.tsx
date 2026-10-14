import { useState } from 'react';

import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { BranchSelect, branchOptions } from '../history/BranchSelect';
import { useRepoRefs } from '../sidebar/useRepoRefs';
import { closeBranchTools } from './branchToolsStore';
import { openCompare } from './compareStore';
import styles from './BranchTools.module.css';

/** Picks the two branches of a comparison (F-104); the result shows in the right panel. */
export function CompareBranchesDialog({
  repoId,
  a: initial,
}: {
  repoId: number;
  a: string | null;
}) {
  const t = useT();
  const refs = useRepoRefs(repoId).data;
  const current = refs?.head.kind === 'branch' ? refs.head.name : null;
  const options = branchOptions(refs, [], true);
  const [a, setA] = useState(initial ?? '');
  const [b, setB] = useState(current && current !== initial ? current : '');
  const ready = a !== '' && b !== '' && a !== b;
  const submit = () => {
    if (!ready) return;
    openCompare(repoId, { a: { rev: a, label: a }, b: { rev: b, label: b } });
    closeBranchTools();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeBranchTools();
      }}
      title={t('compareBranches.title')}
      description={t('compareBranches.description')}
      footer={
        <>
          <Button variant="ghost" onClick={closeBranchTools}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" aria-disabled={!ready} onClick={submit}>
            {t('compareBranches.confirm')}
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
        <BranchSelect label={t('compareBranches.a')} value={a} options={options} onChange={setA} />
        <BranchSelect label={t('compareBranches.b')} value={b} options={options} onChange={setB} />
        {a !== '' && a === b && (
          <p className={styles.status} data-state="invalid" role="alert">
            {t('compareBranches.same')}
          </p>
        )}
      </form>
    </Dialog>
  );
}
