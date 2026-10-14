import { useId, useState, type SyntheticEvent } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { currentPreferences, saveTerminalPreference } from '../../app/preferences';
import { useShellStore } from '../../app/shellStore';
import type { MessageKey } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { YagguiIpcError, type YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { platform } from '../../ui/platform';
import { toast } from '../../ui/toastStore';
import styles from './TerminalDialog.module.css';

const PLACEHOLDER: Record<typeof platform, MessageKey> = {
  mac: 'terminalDialog.placeholder.mac',
  windows: 'terminalDialog.placeholder.windows',
  linux: 'terminalDialog.placeholder.linux',
};

/** Terminal preference (F-266), until the preferences screen exists. */
export function TerminalDialog() {
  const open = useShellStore((state) => state.terminalDialogOpen);
  return open ? <TerminalForm /> : null;
}

function TerminalForm() {
  const t = useT();
  const inputId = useId();
  const [value, setValue] = useState(() => currentPreferences().terminal ?? '');
  const [error, setError] = useState<YagguiError | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    useShellStore.getState().setTerminalDialogOpen(false);
  };

  const description =
    platform === 'mac'
      ? t('terminalDialog.description.mac')
      : t('terminalDialog.description.other', {
          fallback: t(
            platform === 'windows'
              ? 'terminalDialog.fallback.windows'
              : 'terminalDialog.fallback.linux',
          ),
        });

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await saveTerminalPreference(value.trim() || null);
      toast({ variant: 'success', title: t('terminalDialog.saved') });
      close();
    } catch (failure) {
      setBusy(false);
      if (failure instanceof YagguiIpcError) setError(failure.error);
      else {
        console.error(failure);
        toast({ variant: 'error', title: t('terminalDialog.saveFailed') });
      }
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={t('terminalDialog.title')}
      description={description}
    >
      <form
        className={styles.form}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div className={styles.field}>
          <label className={styles.label} htmlFor={inputId}>
            {t('terminalDialog.label')}
          </label>
          <input
            id={inputId}
            autoFocus
            className={styles.input}
            value={value}
            placeholder={t(PLACEHOLDER[platform])}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
          />
        </div>
        {error && <ErrorPanel compact title={t('terminalDialog.saveFailed')} error={error} />}
        <div className={styles.footer}>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {t('terminalDialog.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
