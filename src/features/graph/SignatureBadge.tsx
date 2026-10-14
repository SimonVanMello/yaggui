import { useQuery } from '@tanstack/react-query';

import { useT } from '../../i18n/useT';
import { ipc, unwrap, type SignatureKind, type SignatureStatus } from '../../ipc';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { Tooltip } from '../../ui/Tooltip';
import styles from './CommitDetailPanel.module.css';
import { SIGNATURE_KIND_LABEL } from './signatureLabel';

const TONE: Record<SignatureStatus, 'success' | 'warning' | 'danger' | 'muted'> = {
  verified: 'success',
  unverified: 'warning',
  expired: 'warning',
  revoked: 'danger',
  bad: 'danger',
  unsigned: 'muted',
};

/**
 * Signature of a commit (F-066): its kind at once, then what Git says of it (`%G?`), checked
 * lazily since gpg or ssh-keygen may take a moment.
 */
export function SignatureBadge({
  repoId,
  sha,
  kind,
}: {
  repoId: number;
  sha: string;
  kind: SignatureKind;
}) {
  const t = useT();
  const check = useQuery({
    queryKey: ['commit-signature', repoId, sha],
    queryFn: () => unwrap(ipc.commands.verifyCommitSignature(repoId, sha)),
    staleTime: Infinity,
    retry: false,
  });
  const label = SIGNATURE_KIND_LABEL[kind];
  if (check.isPending) {
    return (
      <span className={styles.badge} data-tone="muted">
        <Spinner />
        {t('graph.signature.checking', { kind: label })}
      </span>
    );
  }
  if (check.isError) {
    return (
      <span className={styles.badge} data-tone="muted">
        {t('graph.signature.signed', { kind: label })}
      </span>
    );
  }
  const { status, signer, key, reason } = check.data;
  const details = [
    signer && t('graph.signature.signer', { signer }),
    key && t('graph.signature.key', { key }),
    reason,
  ]
    .filter(Boolean)
    .join('\n');
  const badge = (
    <span className={styles.badge} data-tone={TONE[status]} tabIndex={details ? 0 : undefined}>
      <Icon name={status === 'verified' ? 'check' : status === 'unverified' ? 'lock' : 'warning'} />
      {t(`graph.signature.${status}`, { kind: label })}
    </span>
  );
  return details ? (
    <Tooltip content={<span className={styles.badgeDetails}>{details}</span>}>{badge}</Tooltip>
  ) : (
    badge
  );
}
