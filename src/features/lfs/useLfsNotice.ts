import { useEffect } from 'react';

import { explainLfsMissing } from './lfsOps';
import { useLfsStatus } from './lfsQueries';

/** Repositories already told about the missing `git lfs` during this session. */
const warned = new Set<number>();

/**
 * A repository that uses LFS while `git lfs` is not installed still opens and works (its
 * large files stay pointers): the user is told once, in a toast, never with a blocking error.
 */
export function useLfsNotice(repoId: number | null): void {
  const status = useLfsStatus(repoId).data;
  useEffect(() => {
    if (repoId === null || !status || !status.used || status.version !== null) return;
    if (warned.has(repoId)) return;
    warned.add(repoId);
    explainLfsMissing({
      code: 'lfsNotInstalled',
      message: { en: '', fr: '' },
      action: null,
      detail: null,
      payload: null,
    });
  }, [repoId, status]);
}
