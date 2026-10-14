import { useState } from 'react';

import { WORKSPACE_NAME_MAX } from '../../ipc';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { TextInput } from '../../ui/TextInput';
import styles from './NameForm.module.css';

interface NameFormProps {
  initial?: string;
  /** Accessible name of the field. */
  label: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}

/** Inline field to name a workspace (create or rename); `Esc` cancels. */
export function NameForm({ initial = '', label, submitLabel, onSubmit, onCancel }: NameFormProps) {
  const t = useT();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const empty = name.trim() === '';
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (empty || busy) return;
        setBusy(true);
        void onSubmit(name.trim()).finally(() => {
          setBusy(false);
        });
      }}
    >
      <TextInput
        // The form appears on demand: typing the name is the only thing to do.
        autoFocus
        aria-label={label}
        placeholder={t('workspace.name.placeholder')}
        maxLength={WORKSPACE_NAME_MAX}
        value={name}
        className={styles.input}
        onChange={(event) => {
          setName(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            // Leaves the dialog open: only the inline form is dismissed.
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      <Button size="sm" type="submit" variant="primary" disabled={empty || busy}>
        {submitLabel}
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
    </form>
  );
}
