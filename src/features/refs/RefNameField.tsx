import { useId } from 'react';

import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import type { YagguiError } from '../../ipc';
import styles from './RefDialogs.module.css';
import type { NameCheck } from './useRefNameCheck';

interface RefNameFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  check: NameCheck;
  /** Error returned by the write itself (name taken in the meantime…), shown like a check. */
  submitError: YagguiError | null;
  placeholder?: string;
  /** Text shown once the name is checked and free (default: `refs.name.valid`). */
  validText?: string;
  autoFocus?: boolean;
}

/** Name input with its live verdict underneath (F-100): one message area, announced politely. */
export function RefNameField({
  label,
  value,
  onChange,
  check,
  submitError,
  placeholder,
  validText,
  autoFocus = true,
}: RefNameFieldProps) {
  const t = useT();
  const statusId = useId();
  const error = check.status === 'invalid' ? check.error : submitError;
  const state = error ? 'invalid' : check.status;
  return (
    <div className={styles.field}>
      <label className={styles.field}>
        <span>{label}</span>
        <input
          className={`${styles.input} ${styles.mono}`}
          value={value}
          autoFocus={autoFocus}
          spellCheck={false}
          autoComplete="off"
          placeholder={placeholder}
          aria-invalid={error !== null}
          aria-describedby={statusId}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      </label>
      <p id={statusId} className={styles.status} data-state={state} role="status">
        {error
          ? localize(error.message)
          : check.status === 'valid'
            ? (validText ?? t('refs.name.valid'))
            : check.status === 'checking'
              ? t('refs.name.checking')
              : ''}
      </p>
    </div>
  );
}
