import { useEffect, useId, useState } from 'react';

import { updatePreferences } from '../../app/preferences';
import { usePreferences } from '../../app/usePreferences';
import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { YagguiIpcError, ipc, unwrap, type YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Field } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { TextInput } from '../../ui/TextInput';
import { toast } from '../../ui/toastStore';
import { gitStatus, type GitStatus } from './prefsLogic';
import { useDraft } from './useDraft';
import styles from './GitTab.module.css';

const PROBE_DELAY_MS = 300;

/** Path of the Git binary (F-322): detected, editable, with its version and a warning if old. */
export function GitTab() {
  const t = useT();
  const inputId = useId();
  const stored = usePreferences().gitPath;
  const [draft, setDraft] = useDraft(stored ?? '');
  const [status, setStatus] = useState<GitStatus>({ kind: 'checking' });
  const [saveError, setSaveError] = useState<YagguiError | null>(null);
  const [busy, setBusy] = useState(false);

  const requested = draft.trim() || null;

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void unwrap(ipc.commands.gitBinaryInfo(requested))
        .then((info) => {
          if (active) setStatus(gitStatus(info));
        })
        .catch((failure: unknown) => {
          console.warn('Git check failed', failure);
          if (active) setStatus({ kind: 'error', reason: 'invalid' });
        });
    }, PROBE_DELAY_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [requested]);

  const edit = (value: string) => {
    setDraft(value);
    setStatus({ kind: 'checking' });
    setSaveError(null);
  };

  const apply = async (path: string | null) => {
    if (busy) return;
    setBusy(true);
    setSaveError(null);
    try {
      await updatePreferences({ gitPath: path });
      toast({ variant: 'success', title: t('prefs.git.saved') });
    } catch (failure) {
      if (failure instanceof YagguiIpcError) setSaveError(failure.error);
      else console.error(failure);
    } finally {
      setBusy(false);
    }
  };

  const dirty = requested !== stored;

  return (
    <>
      <Field label={t('prefs.git.path')} htmlFor={inputId}>
        <form
          className={styles.row}
          onSubmit={(event) => {
            event.preventDefault();
            if (dirty) void apply(requested);
          }}
        >
          <TextInput
            id={inputId}
            mono
            value={draft}
            invalid={status.kind === 'error' || saveError !== null}
            placeholder={t('prefs.git.path.placeholder')}
            onChange={(event) => {
              edit(event.target.value);
            }}
          />
          <Button
            type="submit"
            variant="primary"
            disabled={!dirty || busy || status.kind === 'error'}
          >
            {t('prefs.git.apply')}
          </Button>
          <Button
            disabled={busy || (draft === '' && stored === null)}
            onClick={() => {
              edit('');
              void apply(null);
            }}
          >
            {t('prefs.git.detect')}
          </Button>
        </form>
      </Field>
      <div className={styles.status} aria-live="polite" data-kind={status.kind}>
        <GitStatusLine status={status} />
      </div>
      {saveError && (
        <p className={styles.error} role="alert">
          {localize(saveError.message)}
        </p>
      )}
    </>
  );
}

function GitStatusLine({ status }: { status: GitStatus }) {
  const t = useT();
  switch (status.kind) {
    case 'checking':
      return <span className={styles.muted}>{t('prefs.git.checking')}</span>;
    case 'ok':
      return (
        <>
          <Icon name="check" className={styles.okIcon} />
          <span>{t('prefs.git.ok', { version: status.version, path: status.path })}</span>
        </>
      );
    case 'old':
      return (
        <>
          <Icon name="warning" className={styles.warnIcon} />
          <span>
            {t('prefs.git.ok', { version: status.version, path: status.path })}
            <br />
            {t('prefs.git.old', { version: status.version, min: status.min })}
          </span>
        </>
      );
    case 'error':
      return (
        <>
          <Icon name="error" className={styles.errorIcon} />
          <span>
            {status.reason === 'notFound' ? t('prefs.git.notFound') : t('prefs.git.invalid')}
          </span>
        </>
      );
  }
}
