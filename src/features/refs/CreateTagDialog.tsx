import { useState, type SubmitEvent } from 'react';

import { useT } from '../../i18n/useT';
import type { YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { useRefDialogs, type RefDialog } from './refDialogsStore';
import styles from './RefDialogs.module.css';
import { createTag } from './refOps';
import { RefNameField } from './RefNameField';
import { useRefNameCheck } from './useRefNameCheck';

type Props = Extract<RefDialog, { kind: 'createTag' }>;

/** Lightweight tag, or annotated when a message is given (F-200); signing needs a message. */
export function CreateTagDialog({ repoId, target, targetLabel }: Props) {
  const t = useT();
  const close = useRefDialogs((state) => state.close);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [sign, setSign] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<YagguiError | null>(null);
  const annotated = message.trim() !== '';
  const check = useRefNameCheck(repoId, 'tag', name);
  const canSubmit = name !== '' && check.status !== 'invalid' && !busy;

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    void createTag(repoId, {
      name,
      target,
      message: annotated ? message.trim() : null,
      sign: annotated && sign,
    }).then((result) => {
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
      title={t('refs.createTag.title')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="create-tag" aria-disabled={!canSubmit}>
            {t('refs.createTag.create')}
          </Button>
        </>
      }
    >
      <form id="create-tag" className={styles.form} onSubmit={submit}>
        <div className={styles.from}>
          {t('refs.createTag.on')} <code>{targetLabel}</code>
        </div>
        <RefNameField
          label={t('refs.createTag.name')}
          value={name}
          onChange={(value) => {
            setName(value);
            setError(null);
          }}
          check={check}
          submitError={error}
          placeholder="v1.0.0"
        />
        <label className={styles.field}>
          <span>{t('refs.createTag.message')}</span>
          <textarea
            className={styles.textarea}
            value={message}
            onChange={(event) => {
              setMessage(event.target.value);
            }}
          />
        </label>
        <p className={styles.hint}>
          {annotated ? t('refs.createTag.annotated') : t('refs.createTag.lightweight')}
        </p>
        <label className={styles.check} data-disabled={!annotated}>
          <input
            type="checkbox"
            checked={annotated && sign}
            disabled={!annotated}
            onChange={(event) => {
              setSign(event.target.checked);
            }}
          />
          <span>{t('refs.createTag.sign')}</span>
        </label>
      </form>
    </Dialog>
  );
}
