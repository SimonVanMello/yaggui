import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Query } from '@tanstack/react-query';

import { ipc } from '../../ipc';

/**
 * Hidden tab views (`<Activity mode="hidden">`) have their effects torn down: their query
 * observers, watcher subscriptions, timers and key handlers stop. This module brings them back
 * up to date when they are shown again, touching only what changed meanwhile:
 * - queries invalidated by a backend event while hidden are stale and refetch on reveal;
 *   the others are kept as they are (`refetchOnMount` below);
 * - `useRepoEvent` handlers missed while hidden run once on reveal.
 */

let revealing = 0;

/** `refetchOnMount` default: a reveal refetches only what an event invalidated while hidden. */
export function refetchOnMount(query: Query): boolean {
  return revealing === 0 || query.state.isInvalidated;
}

/**
 * Marks the reveal of a kept view, from its root. Layout effects run before any passive
 * effect, and the root's passive effect after its subtree's: the query observers resubscribe in
 * between. The first mount is not a reveal: it fetches as usual.
 */
export function useRevealGuard(): void {
  const shown = useRef(false);
  const inReveal = useRef(false);
  useLayoutEffect(() => {
    if (shown.current) {
      revealing += 1;
      inReveal.current = true;
    }
    shown.current = true;
    return () => {
      // Hidden or unmounted before its passive effects ran: the reveal is over all the same.
      if (!inReveal.current) return;
      inReveal.current = false;
      revealing -= 1;
    };
  }, []);
  useEffect(() => {
    if (!inReveal.current) return;
    inReveal.current = false;
    revealing -= 1;
  }, []);
}

export type RepoEventName = 'statusChanged' | 'refsChanged';

/** Number of `name` events received per repository, the "dirty" counter of hidden views. */
const versions: Record<RepoEventName, Map<number, number>> = {
  statusChanged: new Map(),
  refsChanged: new Map(),
};
let counting = false;

function startCounting(): void {
  if (counting) return;
  counting = true;
  for (const name of ['statusChanged', 'refsChanged'] as const) {
    ipc.events.subscribe(name, ({ repoId }) => {
      versions[name].set(repoId, (versions[name].get(repoId) ?? 0) + 1);
    });
  }
}

export function repoEventVersion(name: RepoEventName, repoId: number): number {
  return versions[name].get(repoId) ?? 0;
}

/**
 * Runs `onEvent` on each `name` event of `repoId`, like `useYagguiEvent`, and once when the
 * view is shown again if any arrived while it was hidden.
 */
export function useRepoEvent(name: RepoEventName, repoId: number, onEvent: () => void): void {
  startCounting();
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });
  // The version counted when the effect was torn down, for that event of that repository:
  // a hidden view compares it on reveal, a view switched to another repository starts over.
  const seen = useRef<{ name: RepoEventName; repoId: number; version: number } | null>(null);
  useEffect(() => {
    const last = seen.current;
    if (
      last !== null &&
      last.name === name &&
      last.repoId === repoId &&
      last.version !== repoEventVersion(name, repoId)
    ) {
      handler.current();
    }
    const unsubscribe = ipc.events.subscribe(name, (payload) => {
      if (payload.repoId === repoId) handler.current();
    });
    return () => {
      unsubscribe();
      seen.current = { name, repoId, version: repoEventVersion(name, repoId) };
    };
  }, [name, repoId]);
}
