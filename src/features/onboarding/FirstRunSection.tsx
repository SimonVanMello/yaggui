import { useId, type ReactNode } from 'react';

import styles from './FirstRunDialog.module.css';

/** One row of the first-launch screen: its title on the left, its controls on the right. */
export function FirstRunSection({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h3 id={id} className={styles.sectionTitle}>
        {title}
      </h3>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}
