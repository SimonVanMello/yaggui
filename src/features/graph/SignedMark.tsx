import { translate, type Locale } from '../../i18n/i18n';
import type { SignatureKind } from '../../ipc';
import { Icon } from '../../ui/Icon';
import styles from './GraphRowView.module.css';
import { SIGNATURE_KIND_LABEL } from './signatureLabel';

/**
 * Signed commit (F-066): the kind read from the header, never verified here (gpg or ssh-keygen
 * per row would be far too slow). A native tooltip keeps the row cheap to mount while scrolling.
 */
export function SignedMark({ kind, locale }: { kind: SignatureKind; locale: Locale }) {
  const label = translate(locale, 'graph.signature.row', { kind: SIGNATURE_KIND_LABEL[kind] });
  return (
    <span className={styles.signature} title={label} role="img" aria-label={label}>
      <Icon name="lock" />
    </span>
  );
}
