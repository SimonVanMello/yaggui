import { currentPreferences, subscribePreferences } from '../../app/preferences';
import { selectRunningOp, useOpsStore } from '../repo/opsStore';
import { useRepoSessions } from '../repo/repoSessions';
import { fetchRepo } from './networkOps';

/**
 * Auto-fetch (F-120): every open repository, whether its tab is visible, kept alive in the
 * background or unmounted, fetches all its remotes periodically and silently. One timer per
 * repository session, started when the session opens (so the first fetch comes one full
 * period later, which spreads the repositories restored at startup by their open order) and
 * stopped when its last tab closes. The period and the on / off switch are preferences
 * (F-324); a change restarts every timer, so it applies from the next period.
 */

const timers = new Map<number, ReturnType<typeof setInterval>>();
/** Repositories whose automatic fetch has not returned yet: never two at once. */
const inFlight = new Set<number>();
let unsubscribe: (() => void) | undefined;

function tick(repoId: number): void {
  if (useRepoSessions.getState().sessions[repoId]?.status !== 'open') return;
  if (inFlight.has(repoId) || selectRunningOp(repoId)(useOpsStore.getState())) return;
  inFlight.add(repoId);
  void fetchRepo(repoId, { silent: true }).finally(() => {
    inFlight.delete(repoId);
  });
}

function stopTimer(repoId: number): void {
  const timer = timers.get(repoId);
  if (timer === undefined) return;
  clearInterval(timer);
  timers.delete(repoId);
}

/** Starts or stops the timers so that exactly the open repositories have one. */
function sync(): void {
  const { autoFetch, autoFetchMinutes } = currentPreferences();
  const { sessions } = useRepoSessions.getState();
  for (const repoId of timers.keys()) {
    if (!autoFetch || sessions[repoId]?.status !== 'open') stopTimer(repoId);
  }
  if (!autoFetch) return;
  for (const [key, session] of Object.entries(sessions)) {
    const repoId = Number(key);
    if (session?.status !== 'open' || timers.has(repoId)) continue;
    timers.set(
      repoId,
      setInterval(
        () => {
          tick(repoId);
        },
        autoFetchMinutes * 60 * 1000,
      ),
    );
  }
}

/** Installs the scheduler once per app launch; the open repositories get their timer at once. */
export function startAutoFetch(): void {
  if (unsubscribe) return;
  const unsubscribeSessions = useRepoSessions.subscribe(sync);
  const unsubscribePreferences = subscribePreferences(() => {
    // A new period (or switch) applies from now on: every timer restarts.
    for (const repoId of timers.keys()) stopTimer(repoId);
    sync();
  });
  unsubscribe = () => {
    unsubscribeSessions();
    unsubscribePreferences();
  };
  sync();
}

/** Stops every timer and the scheduler (tests). */
export function stopAutoFetch(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  for (const repoId of timers.keys()) stopTimer(repoId);
  inFlight.clear();
}

/** Repositories with a running auto-fetch timer (tests and diagnostics). */
export function autoFetchedRepos(): number[] {
  return [...timers.keys()];
}
