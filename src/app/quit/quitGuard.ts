import { parseEditKey, useFileEditStore } from '../../features/diff/fileEditStore';
import { useRebaseStore } from '../../features/rebase/rebaseStore';
import { useOpsStore } from '../../features/repo/opsStore';
import { repoDisplayName, useRepoSessions } from '../../features/repo/repoSessions';
import { translate, useI18nStore, type MessageParams } from '../../i18n/i18n';
import type { KnownRepo, OpKind } from '../../ipc';
import { confirm } from '../errors/confirmStore';
import { queryClient, queryKeys } from '../queryClient';

/** Something a quit would interrupt or lose (F-xxx quit guard). */
export type PendingWork =
  | { kind: 'op'; op: OpKind; repo: string | null }
  | { kind: 'rebase'; repo: string }
  | { kind: 'file'; path: string; repo: string };

export interface PendingWorkSources {
  /** Running Git operations (background ones never reach the ops store). */
  running: readonly { repoId: number; kind: OpKind }[];
  /** Repositories whose interactive rebase view holds an edited, not started todo. */
  editedRebases: readonly number[];
  unsavedFiles: readonly { repoId: number; path: string }[];
  /** Display name of a repository; `null` when it is not open nor known. */
  repoName: (repoId: number) => string | null;
}

/**
 * What blocks a quit, in a stable order: operations, then rebases, then files. Edits of a
 * repository that is no longer open are gone with it and do not count.
 */
export function pendingWork(sources: PendingWorkSources): PendingWork[] {
  const work: PendingWork[] = sources.running.map((op) => ({
    kind: 'op',
    op: op.kind,
    repo: sources.repoName(op.repoId),
  }));
  for (const repoId of sources.editedRebases) {
    const repo = sources.repoName(repoId);
    if (repo !== null) work.push({ kind: 'rebase', repo });
  }
  for (const file of sources.unsavedFiles) {
    const repo = sources.repoName(file.repoId);
    if (repo !== null) work.push({ kind: 'file', path: file.path, repo });
  }
  return work;
}

type Translate = (key: Parameters<typeof translate>[1], params?: MessageParams) => string;

/** One line of the confirmation: "Push running in api-backoffice". */
export function pendingWorkLabel(work: PendingWork, t: Translate): string {
  switch (work.kind) {
    case 'op':
      return work.repo === null
        ? t('quit.pending.opNoRepo', { op: t(`op.${work.op}`) })
        : t('quit.pending.op', { op: t(`op.${work.op}`), repo: work.repo });
    case 'rebase':
      return t('quit.pending.rebase', { repo: work.repo });
    case 'file':
      return t('quit.pending.file', { path: work.path, repo: work.repo });
  }
}

/** Name of an open repository; of a known one for an operation on a closed repository. */
function repoName(repoId: number): string | null {
  const session = useRepoSessions.getState().sessions[repoId];
  if (session) return repoDisplayName(session, undefined);
  const known = queryClient
    .getQueryData<KnownRepo[]>(queryKeys.knownRepos)
    ?.find((repo) => repo.id === repoId);
  return known?.name ?? null;
}

/** Reads the stores. Rebases and files of a closed repository are ignored (see `pendingWork`). */
export function currentPendingWork(): PendingWork[] {
  const sessions = useRepoSessions.getState().sessions;
  const isOpen = (repoId: number) => sessions[repoId] !== undefined;
  const running = Object.values(useOpsStore.getState().running).filter((op) => op !== undefined);
  const editedRebases = Object.entries(useRebaseStore.getState().sessions)
    .filter(([, session]) => session?.edited === true && session.stop === null)
    .map(([repoId]) => Number(repoId))
    .filter(isOpen);
  const unsavedFiles = Object.keys(useFileEditStore.getState().unsaved)
    .map(parseEditKey)
    .filter((file) => isOpen(file.repoId));
  return pendingWork({ running, editedRebases, unsavedFiles, repoName });
}

/** Most lines listed in the confirmation; the rest is counted. */
const MAX_LISTED = 8;

let asking: Promise<boolean> | null = null;

/**
 * Whether the app may quit (or its window close) now: at once when nothing is in progress,
 * else after "Quit anyway" in a confirmation that lists what is in progress. A request that
 * arrives while the confirmation is open waits for the same answer.
 */
export function confirmLeave(): Promise<boolean> {
  if (asking) return asking;
  const work = currentPendingWork();
  if (work.length === 0) return Promise.resolve(true);
  const locale = useI18nStore.getState().locale;
  const t: Translate = (key, params) => translate(locale, key, params);
  asking = confirm({
    title: t('quit.title'),
    description: t('quit.description'),
    confirmLabel: t('quit.confirm'),
    danger: true,
    items: work.slice(0, MAX_LISTED).map((entry) => ({ label: pendingWorkLabel(entry, t) })),
    moreItems: work.length > MAX_LISTED ? work.length - MAX_LISTED : undefined,
  }).finally(() => {
    asking = null;
  });
  return asking;
}
