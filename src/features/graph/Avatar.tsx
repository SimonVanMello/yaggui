import { useState } from 'react';

import { avatarColor, initials } from './avatarStyle';
import { markMissing, useGravatar } from './gravatar';
import styles from './Avatar.module.css';

/**
 * Author badge: initials on a color derived from the email, so it is stable across sessions.
 * With the Gravatar preference on (F-033), the picture covers the initials once loaded.
 */
export function Avatar({ name, email, title }: { name: string; email: string; title?: string }) {
  const url = useGravatar(email);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span
      className={styles.avatar}
      style={{ background: `var(--lane-${String(avatarColor(email || name))})` }}
      title={title}
      aria-hidden="true"
    >
      {initials(name)}
      {url !== null && failed !== url && (
        <img
          className={styles.picture}
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => {
            markMissing(url);
            setFailed(url);
          }}
        />
      )}
    </span>
  );
}
