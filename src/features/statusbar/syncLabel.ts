import type { MessageKey, MessageParams } from '../../i18n/i18n';
import type { ErrorCode } from '../../ipc';
import type { FinishedOp } from '../repo/opsStore';

/**
 * Error codes that mean the remote host could not be reached (`classify_network_failure` in
 * `git/errors.rs`). Refused credentials, a missing remote or a rejected push reached it.
 */
const NETWORK_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['hostUnreachable']);

export function isNetworkError(code: ErrorCode | undefined): boolean {
  return code !== undefined && NETWORK_CODES.has(code);
}

/**
 * Offline while the last fetch, pull or push of the repository (cancellations left out)
 * failed for lack of network; the next one that reaches a remote clears it.
 */
export function isOffline(lastNetwork: FinishedOp | undefined): boolean {
  return lastNetwork?.outcome === 'failed' && isNetworkError(lastNetwork.errorCode);
}

export interface SyncLabel {
  key: MessageKey;
  params?: MessageParams;
  tone?: 'warning';
}

/**
 * Text of the status bar item. `lastFetchedAt` is the `FETCH_HEAD` time in seconds (`null`:
 * never fetched); `when` is the already formatted relative time of it.
 */
export function syncLabel(
  lastFetchedAt: number | null,
  offline: boolean,
  when: (epochSeconds: number) => string,
): SyncLabel {
  if (offline) {
    return lastFetchedAt === null
      ? { key: 'status.sync.offlineNever', tone: 'warning' }
      : { key: 'status.sync.offline', params: { when: when(lastFetchedAt) }, tone: 'warning' };
  }
  return lastFetchedAt === null
    ? { key: 'status.sync.never' }
    : { key: 'status.sync.synced', params: { when: when(lastFetchedAt) } };
}
