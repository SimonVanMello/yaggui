import { useState, type SubmitEvent } from 'react';

import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import type { YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { useRepoRefs } from '../sidebar/useRepoRefs';
import { useRefDialogs, type RefDialog } from './refDialogsStore';
import styles from './RefDialogs.module.css';
import { setUpstream } from './refOps';

type Props = Extract<RefDialog, { kind: 'upstream' }>;

const NONE = '';

/** Sets, changes or removes the upstream of a local branch (F-103). */
export function UpstreamDialog({ repoId, branch, current }: Props) {
  const t = useT();
  const close = useRefDialogs((state) => state.close);
  const refs = useRepoRefs(repoId).data;
  const [choice, setChoice] = useState(current ?? NONE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<YagguiError | null>(null);
  const remotes = refs?.remotes ?? [];
  const canSubmit = !busy && choice !== (current ?? NONE);

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    void setUpstream(repoId, branch, choice === NONE ? null : choice).then((result) => {
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
      title={t('refs.upstream.title', { name: branch })}
      description={t('refs.upstream.description')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="set-upstream" aria-disabled={!canSubmit}>
            {choice === NONE ? t('refs.upstream.remove') : t('refs.upstream.save')}
          </Button>
        </>
      }
    >
      <form id="set-upstream" className={styles.form} onSubmit={submit}>
        <label className={styles.field}>
          <span>{t('refs.upstream.label')}</span>
          <select
            className={`${styles.select} ${styles.mono}`}
            value={choice}
            autoFocus
            onChange={(event) => {
              setChoice(event.target.value);
              setError(null);
            }}
          >
            <option value={NONE}>{t('refs.upstream.none')}</option>
            {remotes.map((remote) => (
              <optgroup key={remote.name} label={remote.name}>
                {remote.branches.map((candidate) => (
                  <option key={candidate.name} value={candidate.name}>
                    {candidate.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        {error && (
          <p className={styles.status} data-state="invalid" role="alert">
            {localize(error.message)}
          </p>
        )}
      </form>
    </Dialog>
  );
}
