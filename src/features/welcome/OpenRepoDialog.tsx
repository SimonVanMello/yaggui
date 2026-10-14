import { useId, useState, type SyntheticEvent } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useShellStore } from '../../app/shellStore';
import { useT } from '../../i18n/useT';
import type { YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { toast } from '../../ui/toastStore';
import { tryOpenRepo } from '../repo/repoSessions';
import { pickRepoFolder } from './openRepository';
import styles from './OpenRepoDialog.module.css';

/**
 * Alternative to the native folder picker: the path is typed or pasted (handy for a path copied
 * from a terminal), or chosen with "Browse…". Dropping a folder on the window also works.
 */
export function OpenRepoDialog() {
  const dialog = useShellStore((state) => state.openDialog);
  return dialog ? <OpenRepoForm targetTabId={dialog.targetTabId ?? undefined} /> : null;
}

function OpenRepoForm({ targetTabId }: { targetTabId: string | undefined }) {
  const t = useT();
  const [path, setPath] = useState('');
  const [error, setError] = useState<YagguiError | null>(null);
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const close = () => {
    useShellStore.getState().closeOpenDialog();
  };

  const submit = async (event?: SyntheticEvent, picked?: string) => {
    event?.preventDefault();
    const value = (picked ?? path).trim();
    if (!value || busy) return;
    setBusy(true);
    const failure = await tryOpenRepo(value, targetTabId);
    setBusy(false);
    if (failure) setError(failure);
    else close();
  };

  const browse = async () => {
    try {
      const picked = await pickRepoFolder();
      if (!picked) return;
      setPath(picked);
      setError(null);
      await submit(undefined, picked);
    } catch (failure) {
      console.warn('Folder picker unavailable', failure);
      toast({ variant: 'warning', title: t('openDialog.pickerFailed') });
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={t('openDialog.title')}
      description={t('openDialog.description')}
    >
      <form
        className={styles.form}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div className={styles.field}>
          <label className={styles.label} htmlFor={inputId}>
            {t('openDialog.path')}
          </label>
          <div className={styles.row}>
            <input
              id={inputId}
              autoFocus
              className={styles.input}
              value={path}
              placeholder={t('openDialog.placeholder')}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setPath(event.target.value);
                setError(null);
              }}
            />
            <Button
              disabled={busy}
              onClick={() => {
                void browse();
              }}
            >
              {t('openDialog.browse')}
            </Button>
          </div>
        </div>
        {error && (
          <ErrorPanel
            compact
            title={t('repo.openFailed')}
            error={error}
            context={{ retry: () => void submit() }}
          />
        )}
        <div className={styles.footer}>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={!path.trim() || busy}>
            {t('openDialog.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
