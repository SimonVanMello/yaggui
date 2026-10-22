import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useReducer, useRef } from 'react';

import { queryClient } from '../../app/queryClient';
import { ipc, unwrap, type TreeEntry, type YagguiError } from '../../ipc';
import { errorOf } from '../inspect/ipcError';
import type { Listing } from './treeModel';

/** Entries per request (the backend's maximum): a 100 000-entry folder is 200 pages. */
export const TREE_PAGE = 500;

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const treeKeys = {
  page: (repoId: number, sha: string, path: string, start: number) =>
    ['tree', repoId, sha, 'list', path, start] as const,
  file: (repoId: number, sha: string, path: string, force: boolean) =>
    ['tree', repoId, sha, 'file', path, force] as const,
};

/** The file at `path` of the commit `sha`; a commit never changes, so neither does this. */
export function useTreeFile(
  repoId: number,
  sha: string | null,
  path: string | null,
  force: boolean,
) {
  return useQuery({
    queryKey: treeKeys.file(repoId, sha ?? '', path ?? '', force),
    queryFn: () => unwrap(ipc.commands.treeFile(repoId, sha ?? '', path ?? '', force)),
    enabled: sha !== null && path !== null,
    staleTime: Infinity,
    // The previous file stays on screen while the next one loads.
    placeholderData: keepPreviousData,
  });
}

interface ListingsState {
  listings: ReadonlyMap<string, Listing>;
  errors: ReadonlyMap<string, YagguiError>;
}

type Action =
  | { type: 'page'; folder: string; entries: readonly TreeEntry[]; total: number; first: boolean }
  | { type: 'error'; folder: string; error: YagguiError };

function reduce(state: ListingsState, action: Action): ListingsState {
  if (action.type === 'error') {
    return { ...state, errors: new Map(state.errors).set(action.folder, action.error) };
  }
  const previous = action.first ? undefined : state.listings.get(action.folder);
  const entries = previous ? [...previous.entries, ...action.entries] : action.entries;
  return {
    ...state,
    listings: new Map(state.listings).set(action.folder, { entries, total: action.total }),
  };
}

export interface TreeListings {
  /** The commit read; `null` until the root answers when `rev` is not a full SHA. */
  sha: string | null;
  listings: ReadonlyMap<string, Listing>;
  /** Folders that could not be read (the root included). */
  errors: ReadonlyMap<string, YagguiError>;
}

/**
 * Lazy folder listings of the commit `rev`: the root, then every folder of `open` as soon as
 * it is open. A folder loads page after page in the background, so its first 500 entries
 * show at once whatever its size. Pages are cached per commit.
 */
export function useTreeListings(
  repoId: number,
  rev: string,
  open: ReadonlySet<string>,
): TreeListings {
  const [state, dispatch] = useReducer(reduce, {
    listings: new Map(),
    errors: new Map(),
  });
  const [sha, setSha] = useReducer(
    (_: string | null, next: string) => next,
    null,
    () => (FULL_SHA.test(rev) ? rev : null),
  );
  const started = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const load = async (folder: string) => {
      let start = 0;
      let at = sha ?? rev;
      try {
        for (;;) {
          const from = start;
          const key = treeKeys.page(repoId, at, folder, from);
          const page = await queryClient.query({
            queryKey: key,
            queryFn: () => unwrap(ipc.commands.treeList(repoId, at, folder, from, TREE_PAGE)),
            staleTime: FULL_SHA.test(at) ? Infinity : 0,
          });
          if (!alive.current) return;
          if (folder === '' && from === 0) {
            at = page.rev;
            setSha(page.rev);
          }
          dispatch({
            type: 'page',
            folder,
            entries: page.entries,
            total: page.total,
            first: from === 0,
          });
          start += page.entries.length;
          if (page.entries.length === 0 || start >= page.total) return;
        }
      } catch (error) {
        if (alive.current && error instanceof Error) {
          dispatch({ type: 'error', folder, error: errorOf(error) });
        }
      }
    };
    // The root first: it resolves a symbolic revision the other folders are read at.
    const wanted = sha === null ? [''] : ['', ...open];
    for (const folder of wanted) {
      if (started.current.has(folder)) continue;
      started.current.add(folder);
      void load(folder);
    }
  }, [repoId, rev, sha, open]);

  return { sha, ...state };
}
