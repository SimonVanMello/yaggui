import { beforeEach, describe, expect, it } from 'vitest';

import type { ErrorCode, OpKind } from '../../ipc';
import { forgetLastFinished, useOpsStore, type FinishedOp } from '../repo/opsStore';
import { isNetworkError, isOffline, syncLabel } from './syncLabel';

const when = (seconds: number) => `at ${String(seconds)}`;

let nextOpId = 1;
function finish(
  kind: OpKind,
  outcome: FinishedOp['outcome'],
  errorCode?: ErrorCode,
  report = true,
): void {
  useOpsStore
    .getState()
    .finished(1, { opId: nextOpId++, kind, outcome, finishedAt: 0, errorCode }, report);
}

const offline = () => isOffline(useOpsStore.getState().lastNetwork[1]);

describe('syncLabel', () => {
  it('reads "never" without a fetch and the relative time with one', () => {
    expect(syncLabel(null, false, when)).toEqual({ key: 'status.sync.never' });
    expect(syncLabel(1_000, false, when)).toEqual({
      key: 'status.sync.synced',
      params: { when: 'at 1000' },
    });
  });

  it('warns when offline, with or without a previous fetch', () => {
    expect(syncLabel(1_000, true, when)).toEqual({
      key: 'status.sync.offline',
      params: { when: 'at 1000' },
      tone: 'warning',
    });
    expect(syncLabel(null, true, when)).toEqual({
      key: 'status.sync.offlineNever',
      tone: 'warning',
    });
  });
});

describe('offline derivation', () => {
  beforeEach(() => {
    useOpsStore.setState({ running: {}, lastFinished: {}, lastNetwork: {} });
  });

  it('only counts errors that mean the host could not be reached', () => {
    expect(isNetworkError('hostUnreachable')).toBe(true);
    for (const code of ['authFailed', 'conflicts', 'pushRejected', 'remoteNotFound'] as const) {
      expect(isNetworkError(code)).toBe(false);
    }
    expect(isNetworkError(undefined)).toBe(false);
  });

  it('is offline from a network failure until a network operation succeeds', () => {
    expect(offline()).toBe(false);
    finish('fetch', 'failed', 'hostUnreachable');
    expect(offline()).toBe(true);
    // A local operation since does not say anything about the network.
    finish('commit', 'success');
    expect(offline()).toBe(true);
    expect(useOpsStore.getState().lastFinished[1]?.kind).toBe('commit');
    // Nor does a cancelled fetch.
    finish('fetch', 'cancelled');
    expect(offline()).toBe(true);
    finish('push', 'success');
    expect(offline()).toBe(false);
  });

  it('is not offline after an authentication failure or a pull stopped on conflicts', () => {
    finish('pull', 'failed', 'authFailed');
    expect(offline()).toBe(false);
    finish('fetch', 'failed', 'hostUnreachable');
    // Reported inline (conflict view), not in the status bar, but the remote was reached.
    finish('pull', 'failed', 'conflicts', false);
    expect(offline()).toBe(false);
  });

  it('forgets the network state of a closed repository', () => {
    finish('fetch', 'failed', 'hostUnreachable');
    forgetLastFinished(1);
    expect(offline()).toBe(false);
  });
});
