import { useId } from 'react';

import { clampInt } from './prefsLogic';
import { Row } from './Row';
import { useDraft } from './useDraft';
import { TextInput } from '../../ui/TextInput';
import styles from './AiTab.module.css';

interface AiNumberRowProps {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onSave: (value: number) => void;
}

/** A whole number saved on blur or Enter, kept within `[min, max]`. */
export function AiNumberRow({ label, hint, value, min, max, disabled, onSave }: AiNumberRowProps) {
  const id = useId();
  const [draft, setDraft] = useDraft(String(value));
  const commit = () => {
    const next = clampInt(draft, min, max, value);
    setDraft(String(next));
    if (next !== value) onSave(next);
  };
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <TextInput
        id={id}
        className={styles.number}
        inputMode="numeric"
        disabled={disabled}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
      />
    </Row>
  );
}
