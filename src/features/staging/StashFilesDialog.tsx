import { useState, type SubmitEvent } from 'react';

import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { TextInput } from '../../ui/TextInput';
import styles from './CommitToolsDialogs.module.css';
import { stashFiles } from './commitToolsOps';
import { useCommitTools, type StashFile } from './commitToolsStore';

/** Partial stash (F-182): `git stash push -- <paths>` with a message, untracked files on request. */
export function StashFilesDialog({ repoId, files }: { repoId: number; files: StashFile[] }) {
  const t = useT();
  const close = useCommitTools((s) => s.close);
  const hasUntracked = files.some((f) => f.untracked);
  const [message, setMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(hasUntracked);
  const [busy, setBusy] = useState(false);
  const stashable = files.filter((f) => includeUntracked || !f.untracked);
  const canSubmit = stashable.length > 0 && !busy;

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    void stashFiles(
      repoId,
      stashable.map((f) => f.path),
      message,
      includeUntracked,
    ).then((result) => {
      if (result.ok) close();
      else setBusy(false);
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('stashFiles.title', { count: files.length })}
      description={t('stashFiles.description')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="stash-files" aria-disabled={!canSubmit}>
            {t('stashFiles.confirm', { count: stashable.length })}
          </Button>
        </>
      }
    >
      <form id="stash-files" className={styles.body} onSubmit={submit}>
        <ul className={styles.files} aria-label={t('stashFiles.files')}>
          {files.map((file) => (
            <li key={file.path} data-skipped={file.untracked && !includeUntracked}>
              {file.path}
              {file.untracked && !includeUntracked && ` — ${t('stashFiles.skipped')}`}
            </li>
          ))}
        </ul>
        <Field label={t('stash.popover.message')} htmlFor="stash-files-message">
          <TextInput
            id="stash-files-message"
            value={message}
            autoFocus
            placeholder={t('stash.popover.placeholder')}
            onChange={(event) => {
              setMessage(event.target.value);
            }}
          />
        </Field>
        {hasUntracked && (
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={includeUntracked}
              onChange={(event) => {
                setIncludeUntracked(event.target.checked);
              }}
            />
            {t('stashFiles.untracked')}
          </label>
        )}
        <p className={styles.hint}>{t('stashFiles.hint')}</p>
      </form>
    </Dialog>
  );
}
