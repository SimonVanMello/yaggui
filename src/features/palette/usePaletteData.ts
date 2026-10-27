import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { ipc, unwrap } from '../../ipc';
import { useGraphNavigation } from '../repo/graphNavigation';
import type { CommitHit, FileSource } from './paletteSources';
import { useT } from '../../i18n/useT';

const COMMIT_DEBOUNCE_MS = 150;
/** Commits shown at most: each one costs a one-row `graphPage` request. */
export const MAX_COMMIT_HITS = 12;
const MAX_CHUNKS = 20;

/**
 * Commits matching `text` (message, author, SHA prefix), best effort: stops after
 * `MAX_COMMIT_HITS` matches or `MAX_CHUNKS` chunks of the backend scan. A result whose graph
 * version changed while it was computed is dropped (its rows would point at other commits).
 */
export function useCommitHits(repoId: number | null, text: string, enabled: boolean) {
  const [state, setState] = useState<{ key: string; hits: CommitHit[] } | null>(null);
  const key = `${String(repoId)}|${text}`;
  const wanted = enabled && repoId !== null && text !== '';

  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const query = { text, author: null, path: null, since: null, until: null };
        let version: number | null = null;
        const rows: number[] = [];
        let from = 0;
        for (let chunks = 0; chunks < MAX_CHUNKS && rows.length < MAX_COMMIT_HITS; chunks++) {
          const chunk = await unwrap(ipc.commands.searchCommits(repoId, query, from));
          if (cancelled || (version !== null && chunk.version !== version)) return;
          version = chunk.version;
          rows.push(...chunk.matches);
          if (chunk.nextRow === null) break;
          from = chunk.nextRow;
        }
        const pages = await Promise.all(
          rows
            .slice(0, MAX_COMMIT_HITS)
            .map((row) => unwrap(ipc.commands.graphPage(repoId, row, 1))),
        );
        if (cancelled) return;
        const hits: CommitHit[] = [];
        for (const [index, page] of pages.entries()) {
          const row = rows[index];
          const sha = page.shas[0];
          if (row === undefined || sha === undefined || page.version !== version) {
            // The graph moved under the search: its rows point at other commits. No commits
            // rather than a spinner that never ends; the next keystroke searches again.
            setState({ key, hits: [] });
            return;
          }
          hits.push({
            sha,
            row,
            version: page.version,
            summary: page.summaries[0] ?? sha,
            author: page.authorNames[0] ?? '',
          });
        }
        setState({ key, hits });
      })().catch((error: unknown) => {
        // The palette is a shortcut: a failing search just shows no commits.
        console.warn('Palette commit search failed', error);
      });
    }, COMMIT_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [wanted, repoId, text, key]);

  return {
    hits: wanted && state?.key === key ? state.hits : [],
    loading: wanted && state?.key !== key,
  };
}

/**
 * Files of the selected commit, or of the working tree (staged, then unstaged) when no commit
 * is selected. Cached by TanStack Query like the rest of the repository data.
 */
export function useFileSources(repoId: number | null, enabled: boolean): FileSource[] {
  const t = useT();
  const selected = useGraphNavigation((state) =>
    repoId === null ? undefined : state.selected[repoId],
  );
  const on = enabled && repoId !== null;
  const commit = useQuery({
    queryKey: ['palette-files', repoId, 'commit', selected],
    queryFn: () =>
      unwrap(
        ipc.commands.changedFiles(repoId ?? 0, { kind: 'commits', from: null, to: selected ?? '' }),
      ),
    enabled: on && selected !== undefined,
    staleTime: Infinity,
  });
  const staged = useQuery({
    queryKey: ['palette-files', repoId, 'staged'],
    queryFn: () => unwrap(ipc.commands.changedFiles(repoId ?? 0, { kind: 'staged' })),
    enabled: on && selected === undefined,
  });
  const unstaged = useQuery({
    queryKey: ['palette-files', repoId, 'unstaged'],
    queryFn: () => unwrap(ipc.commands.changedFiles(repoId ?? 0, { kind: 'unstaged' })),
    enabled: on && selected === undefined,
  });
  const commitFiles = commit.data?.files;
  const stagedFiles = staged.data?.files;
  const unstagedFiles = unstaged.data?.files;
  return useMemo(() => {
    if (selected !== undefined) {
      return commitFiles
        ? [
            {
              target: { kind: 'commits', from: null, to: selected } as const,
              origin: selected.slice(0, 7),
              files: commitFiles,
            },
          ]
        : [];
    }
    const sources: FileSource[] = [];
    if (stagedFiles) {
      sources.push({
        target: { kind: 'staged' },
        origin: t('palette.file.staged'),
        files: stagedFiles,
      });
    }
    if (unstagedFiles) {
      sources.push({
        target: { kind: 'unstaged' },
        origin: t('palette.file.unstaged'),
        files: unstagedFiles,
      });
    }
    return sources;
  }, [selected, commitFiles, stagedFiles, unstagedFiles, t]);
}
