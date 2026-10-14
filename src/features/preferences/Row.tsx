import type { ReactNode } from 'react';

import styles from './Row.module.css';

interface RowProps {
  label: string;
  hint?: string;
  /** `id` of the control, when the row is a single labelled control. */
  htmlFor?: string;
  children: ReactNode;
}

/** A setting: label and hint on the left, its control on the right. */
export function Row({ label, hint, htmlFor, children }: RowProps) {
  return (
    <div className={styles.row}>
      <div className={styles.text}>
        <label className={styles.label} htmlFor={htmlFor}>
          {label}
        </label>
        {hint && <span className={styles.hint}>{hint}</span>}
      </div>
      <div className={styles.control}>{children}</div>
    </div>
  );
}
