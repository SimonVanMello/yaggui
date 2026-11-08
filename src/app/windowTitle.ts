import { workingBranch, shortOid } from '../features/repo/repoStatus';
import type { RepoState } from '../ipc';
import type { Platform } from '../ui/platform';

const APP_NAME = 'yaggui';

/** What HEAD is on, for the title: the branch (the one being rebased during a rebase), else the short SHA. */
export function headLabel(state: RepoState): string {
  if (state.head.kind !== 'detached') return state.head.name;
  return workingBranch(state) ?? shortOid(state.head.oid);
}

/**
 * Window title: `<repo> · <branch>` for a repository tab (just the repository while its state
 * loads), "yaggui" otherwise. macOS apps do not repeat their name; elsewhere the taskbar and
 * the window switcher need it.
 */
export function formatWindowTitle(
  context: { repo: string; branch: string | null } | null,
  target: Platform,
): string {
  if (context === null) return APP_NAME;
  const title = context.branch === null ? context.repo : `${context.repo} · ${context.branch}`;
  return target === 'mac' ? title : `${title} — ${APP_NAME}`;
}
