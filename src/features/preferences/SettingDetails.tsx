import type { ReactNode } from 'react';

import { Icon } from '../../ui/Icon';
import styles from './SettingDetails.module.css';

export interface DetailSection {
  title: string;
  /** One paragraph, or a list of points. */
  body: string | readonly string[];
}

/** Folded explanation under a setting: what it does, how, what to know before turning it on. */
export function SettingDetails({
  summary,
  sections,
}: {
  summary: ReactNode;
  sections: readonly DetailSection[];
}) {
  return (
    <details className={styles.details}>
      <summary className={styles.summary}>
        <Icon name="chevronRight" className={styles.chevron} />
        {summary}
      </summary>
      <div className={styles.body}>
        {sections.map((section) => (
          <section key={section.title} className={styles.section}>
            <h4 className={styles.title}>{section.title}</h4>
            {typeof section.body === 'string' ? (
              <p className={styles.text}>{section.body}</p>
            ) : (
              <ul className={styles.list}>
                {section.body.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </details>
  );
}
