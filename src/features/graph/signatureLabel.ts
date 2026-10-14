import type { SignatureKind } from '../../ipc';

/** Short name of a signature kind, shown in badges and tooltips. */
export const SIGNATURE_KIND_LABEL: Record<SignatureKind, string> = {
  gpg: 'GPG',
  ssh: 'SSH',
  x509: 'X.509',
  unknown: '?',
};
