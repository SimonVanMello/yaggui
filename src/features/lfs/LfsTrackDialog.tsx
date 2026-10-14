import { useId, useState, type SubmitEvent } from 'react';

import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import type { YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { TextInput } from '../../ui/TextInput';
import refStyles from '../refs/RefDialogs.module.css';
import { lfsTrack, useLfsTrackDialog } from './lfsOps';
import { useLfsStatus } from './lfsQueries';
import styles from './Lfs.module.css';

/** `git lfs track <pattern>` (F-262), with the patterns already tracked. */
export function LfsTrackDialog({ repoId }: { repoId: number }) {
  const t = useT();
  const close = useLfsTrackDialog((state) => state.close);
  const status = useLfsStatus(repoId).data;
  const [pattern, setPattern] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<YagguiError | null>(null);
  const inputId = useId();
  const missing = status !== undefined && status.version === null;
  const canSubmit = pattern.trim() !== '' && !busy && !missing;

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    void lfsTrack(repoId, pattern).then((result) => {
      if (result.ok) close();
      else {
        setBusy(false);
        setError(result.error);
      }
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('lfs.track.title')}
      description={t('lfs.track.description')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="lfs-track" aria-disabled={!canSubmit}>
            {t('lfs.track.confirm')}
          </Button>
        </>
      }
    >
      <form id="lfs-track" className={refStyles.form} onSubmit={submit}>
        {missing && (
          <div className={refStyles.warning} role="alert">
            <b>{t('lfs.notInstalled.title')}</b>
            <span>{t('lfs.notInstalled.text')}</span>
          </div>
        )}
        <label className={refStyles.field} htmlFor={inputId}>
          <span>{t('lfs.track.pattern')}</span>
          <TextInput
            id={inputId}
            mono
            autoFocus
            value={pattern}
            placeholder="*.psd"
            invalid={error !== null}
            onChange={(event) => {
              setPattern(event.target.value);
              setError(null);
            }}
          />
        </label>
        <p className={refStyles.hint}>{t('lfs.track.hint')}</p>
        {error && (
          <p className={refStyles.status} data-state="invalid" role="alert">
            {localize(error.message)}
          </p>
        )}
        <div className={refStyles.field}>
          <span>{t('lfs.track.current')}</span>
          {status && status.patterns.length > 0 ? (
            <ul className={styles.patterns}>
              {status.patterns.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : (
            <p className={refStyles.hint}>{t('lfs.track.none')}</p>
          )}
        </div>
        <code
          className={refStyles.command}
        >{`git lfs track -- ${pattern.trim() || '<pattern>'}`}</code>
      </form>
    </Dialog>
  );
}
