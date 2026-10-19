import { useState } from 'react';

import { useI18nStore } from '../i18n/i18n';
import { IconButton } from '../ui/IconButton';
import styles from './DemoBanner.module.css';
import { translateNow } from './translateNow';

/** Thin strip above the title bar of the website's demo; the download link goes back to the site. */
export function DemoBanner() {
  const [dismissed, setDismissed] = useState(false);
  const locale = useI18nStore((state) => state.locale);
  if (dismissed) return null;
  return (
    <div className={styles.banner} role="region" aria-label="Demo">
      <span>{translateNow('demo.banner')}</span>
      <a className={styles.link} href={locale === 'fr' ? '/fr/' : '/'}>
        {translateNow('demo.download')}
      </a>
      <IconButton
        className={styles.dismiss}
        icon="close"
        size="sm"
        label={translateNow('demo.dismiss')}
        onClick={() => {
          setDismissed(true);
        }}
      />
    </div>
  );
}
