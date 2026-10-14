import { RadioGroup } from 'radix-ui';
import type { ReactNode } from 'react';

import styles from './HistoryDialogs.module.css';

export interface Choice<T extends string> {
  value: T;
  title: ReactNode;
  help?: ReactNode;
  /** Destructive choice: highlighted in the danger color when selected. */
  danger?: boolean;
}

/** Single choice among options that each need a sentence of explanation (merge mode, reset mode…). */
export function ChoiceList<T extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: T;
  choices: readonly Choice<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <RadioGroup.Root
      className={styles.group}
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        const choice = choices.find((candidate) => candidate.value === next);
        if (choice) onChange(choice.value);
      }}
    >
      {choices.map((choice) => (
        <RadioGroup.Item
          key={choice.value}
          value={choice.value}
          className={styles.option}
          data-danger={choice.danger ? 'true' : undefined}
        >
          <span className={styles.radio}>
            <RadioGroup.Indicator className={styles.dot} />
          </span>
          <span className={styles.optionText}>
            <span className={styles.optionTitle}>{choice.title}</span>
            {choice.help && <span className={styles.optionHelp}>{choice.help}</span>}
          </span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
