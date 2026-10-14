import { useEffect } from 'react';

import { usePreferences } from '../../app/usePreferences';
import { selectRunningOp, useOpsStore } from '../repo/opsStore';
import { fetchRepo } from './networkOps';

/**
 * Fetches every remote of the repository periodically while its tab is mounted (F-120),
 * silently, unless an operation is already running. The period and the on / off switch are
 * preferences (F-324); a change applies to the next period.
 */
export function useAutoFetch(repoId: number): void {
  const { autoFetch, autoFetchMinutes } = usePreferences();
  useEffect(() => {
    if (!autoFetch) return;
    const timer = setInterval(
      () => {
        if (selectRunningOp(repoId)(useOpsStore.getState())) return;
        void fetchRepo(repoId, { silent: true });
      },
      autoFetchMinutes * 60 * 1000,
    );
    return () => {
      clearInterval(timer);
    };
  }, [repoId, autoFetch, autoFetchMinutes]);
}
