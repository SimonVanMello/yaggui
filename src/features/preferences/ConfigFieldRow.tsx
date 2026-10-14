import { useId, useState } from 'react';

import { useT } from '../../i18n/useT';
import { TextInput } from '../../ui/TextInput';
import type { ConfigField } from './gitConfigLogic';
import { Row } from './Row';
import styles from './GitConfigTab.module.css';

interface ConfigFieldRowProps {
  field: ConfigField;
  /** Value in the file being edited; `null` when the key is not set there. */
  value: string | null;
  /** Value of the global file, shown as a placeholder when editing the repository's. */
  inheritedValue: string | null;
  /** Set several times, or not loaded yet. */
  readOnly: boolean;
  /** Saves the value (`null` removes the key); resolves to `false` when Git refused it. */
  onCommit: (value: string | null) => Promise<boolean>;
}

const NOT_SET = '';

/** One common key: free text saved on Enter or blur, or a choice among Git's values. */
export function ConfigFieldRow({
  field,
  value,
  inheritedValue,
  readOnly,
  onCommit,
}: ConfigFieldRowProps) {
  const t = useT();
  const id = useId();
  const [draft, setDraft] = useState(value ?? '');
  const hint = field.hint ? t(field.hint) : undefined;

  if (field.kind === 'choice') {
    const unlisted = value !== null && !field.values.includes(value);
    return (
      <Row label={t(field.label)} hint={hint} htmlFor={id}>
        <select
          id={id}
          className={styles.select}
          disabled={readOnly}
          value={value ?? NOT_SET}
          onChange={(event) => {
            void onCommit(event.target.value === NOT_SET ? null : event.target.value);
          }}
        >
          <option value={NOT_SET}>
            {inheritedValue
              ? t('gitconfig.notSet.inherited', { value: inheritedValue })
              : t('gitconfig.notSet')}
          </option>
          {/* A value Git accepts but this list does not offer stays visible instead of vanishing. */}
          {unlisted && <option value={value}>{value}</option>}
          {field.values.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      </Row>
    );
  }

  const commit = () => {
    const next = draft.trim() || null;
    if (next === value) return;
    void onCommit(next).then((saved) => {
      if (!saved) setDraft(value ?? '');
    });
  };
  return (
    <Row label={t(field.label)} hint={hint} htmlFor={id}>
      <TextInput
        id={id}
        mono
        disabled={readOnly}
        value={draft}
        placeholder={inheritedValue ?? t('gitconfig.notSet')}
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
