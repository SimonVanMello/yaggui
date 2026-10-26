import { confirm } from '../../app/errors/confirmStore';
import { showError, showYagguiError } from '../../app/errors/presentError';
import { currentPreferences } from '../../app/preferences';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import {
  YagguiIpcError,
  ipc,
  unwrap,
  type YagguiError,
  type OpKind,
  type PullStrategy,
  type PushRequest,
} from '../../ipc';
import { toast } from '../../ui/toastStore';
import { refreshHistory, reportConflicts } from '../history/historyOps';
import { refreshRefs } from '../refs/refOps';
import { repoDisplayName, useRepoSessions } from '../repo/repoSessions';
import { shortOid } from '../repo/repoStatus';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

function asYagguiError(error: unknown): YagguiError | null {
  return error instanceof YagguiIpcError ? error.error : null;
}

/**
 * Name of the repository, for the toasts: with several tabs (auto-fetch, "Fetch all") a
 * result could not be attributed otherwise. `undefined` when the session is gone.
 */
function repoLabel(repoId: number): string | undefined {
  return repoDisplayName(useRepoSessions.getState().sessions[repoId], undefined) ?? undefined;
}

/**
 * Network failures are toasted here, not by the `op-finished` handler: only the caller can
 * offer "Pull then push" or "Set upstream". A cancellation is already reported there.
 */
function report(repoId: number, kind: OpKind, error: unknown, retry?: () => void): void {
  const yaggui = asYagguiError(error);
  if (!yaggui) {
    showError(error);
    return;
  }
  if (yaggui.code === 'cancelled') return;
  const repo = repoLabel(repoId);
  showYagguiError(yaggui, {
    title:
      repo === undefined
        ? t('op.toast.failed', { op: t(`op.${kind}`) })
        : t('op.toast.failedIn', { op: t(`op.${kind}`), repo }),
    retry,
    pullThenPush: () => {
      void (async () => {
        if (await pullRepo(repoId, null)) await pushRepo(repoId);
      })();
    },
    pushSetUpstream: () => {
      void pushRepo(repoId, { setUpstream: true });
    },
  });
}

export async function fetchRepo(
  repoId: number,
  {
    remote = null,
    prune = currentPreferences().prune,
    silent = false,
  }: {
    remote?: string | null;
    prune?: boolean;
    /** Automatic fetch: no toast, success or failure (the status bar still shows it). */
    silent?: boolean;
  } = {},
): Promise<boolean> {
  try {
    await unwrap(
      ipc.commands.fetch(
        repoId,
        remote === null ? { kind: 'all' } : { kind: 'remote', name: remote },
        prune,
      ),
    );
    if (!silent) {
      toast({
        variant: 'success',
        title: t('network.fetch.done'),
        description: repoLabel(repoId),
        duration: 3000,
      });
    }
    return true;
  } catch (error) {
    if (!silent) {
      report(repoId, 'fetch', error, () => {
        void fetchRepo(repoId, { remote, prune });
      });
    }
    return false;
  } finally {
    refreshRefs(repoId);
  }
}

/** `strategy: null` uses the repository's configured default. */
export async function pullRepo(repoId: number, strategy: PullStrategy | null): Promise<boolean> {
  try {
    const result = await unwrap(ipc.commands.pull(repoId, strategy));
    toast({
      variant: 'success',
      title: t(result.upToDate ? 'network.pull.upToDate' : 'network.pull.done', {
        strategy: t(`network.strategy.${result.strategy}`),
      }),
      description: repoLabel(repoId),
      duration: 3000,
    });
    return true;
  } catch (error) {
    const yaggui = asYagguiError(error);
    if (yaggui?.code === 'conflicts') {
      // The merge or rebase of the pull is now in progress: same banner and conflict view
      // as a merge or rebase started from the graph.
      reportConflicts(repoId, yaggui);
      refreshHistory(repoId);
      return false;
    }
    report(repoId, 'pull', error, () => {
      void pullRepo(repoId, strategy);
    });
    return false;
  } finally {
    refreshRefs(repoId);
  }
}

async function defaultRemote(repoId: number): Promise<string | null> {
  const remotes = await unwrap(ipc.commands.listRemotes(repoId));
  return remotes[0] ?? null;
}

/**
 * Pushes a branch (default: the checked out one). Without an upstream, asks to create it
 * on the default remote first (F-122).
 */
export async function pushRepo(
  repoId: number,
  { branch = null, setUpstream = false }: { branch?: string | null; setUpstream?: boolean } = {},
): Promise<boolean> {
  const request: PushRequest = {
    branch,
    setUpstream: false,
    remote: null,
    forceWithLease: false,
    expectedSha: null,
  };
  try {
    if (setUpstream) {
      const confirmed = await confirmUpstream(repoId, branch);
      if (!confirmed) return false;
      request.setUpstream = true;
      request.remote = confirmed.remote;
    }
    const result = await unwrap(ipc.commands.push(repoId, request));
    toast({
      variant: 'success',
      title: t(result.upToDate ? 'network.push.upToDate' : 'network.push.done', {
        target: `${result.remote}/${result.remoteBranch}`,
      }),
      description: repoLabel(repoId),
      duration: 3000,
    });
    return true;
  } catch (error) {
    if (!setUpstream && asYagguiError(error)?.code === 'noUpstream') {
      return await pushRepo(repoId, { branch, setUpstream: true });
    }
    report(repoId, 'push', error, () => {
      void pushRepo(repoId, { branch, setUpstream });
    });
    return false;
  } finally {
    refreshRefs(repoId);
  }
}

async function confirmUpstream(
  repoId: number,
  branch: string | null,
): Promise<{ remote: string } | null> {
  const remote = await defaultRemote(repoId);
  if (remote === null) {
    toast({ variant: 'warning', title: t('network.noRemote') });
    return null;
  }
  const state = await unwrap(ipc.commands.repoState(repoId));
  const name = branch ?? (state.head.kind === 'detached' ? 'HEAD' : state.head.name);
  const ok = await confirm({
    title: t('network.upstream.title'),
    description: t('network.upstream.description', { branch: name, target: `${remote}/${name}` }),
    command: `git push --set-upstream ${remote} ${name}`,
    confirmLabel: t('network.upstream.confirm'),
  });
  return ok ? { remote } : null;
}

/**
 * Force push with `--force-with-lease`, after a confirmation listing the remote commits
 * that would be dropped. The lease is the remote SHA the confirmation showed.
 */
export async function forcePushRepo(repoId: number, branch: string | null = null): Promise<void> {
  try {
    const preview = await unwrap(ipc.commands.forcePushPreview(repoId, branch));
    const target = `${preview.remote}/${preview.remoteBranch}`;
    if (preview.protected) {
      toast({
        variant: 'warning',
        title: t('network.force.protected', { branch: preview.remoteBranch }),
      });
      return;
    }
    const count = preview.overwritten.length;
    const confirmed = await confirm({
      title: t('network.force.title', { target }),
      description:
        count === 0
          ? t('network.force.nothingLost', { target })
          : t('network.force.description', { target, count }),
      command: `git push --force-with-lease=refs/heads/${preview.remoteBranch}:${
        preview.remoteSha ?? ''
      } ${preview.remote} refs/heads/${preview.branch}:refs/heads/${preview.remoteBranch}`,
      confirmLabel: t('network.force.confirm'),
      danger: true,
      items: preview.overwritten.map((commit) => ({
        label: `${shortOid(commit.sha)} ${commit.summary}`,
        note: commit.author,
        danger: true,
      })),
      moreItems: preview.hidden > 0 ? preview.hidden : undefined,
    });
    if (!confirmed) return;
    await unwrap(
      ipc.commands.push(repoId, {
        branch,
        setUpstream: false,
        remote: null,
        forceWithLease: true,
        expectedSha: preview.remoteSha,
      }),
    );
    toast({
      variant: 'success',
      title: t('network.force.done', { target }),
      description: repoLabel(repoId),
      duration: 3000,
    });
  } catch (error) {
    report(repoId, 'push', error);
  } finally {
    refreshRefs(repoId);
  }
}

/** `remote` or, when `null`, the default one (`origin` first); toasts when there is none. */
async function remoteOrDefault(repoId: number, remote: string | null): Promise<string | null> {
  const chosen = remote ?? (await defaultRemote(repoId));
  if (chosen === null) toast({ variant: 'warning', title: t('network.noRemote') });
  return chosen;
}

/** Pushes one tag to `remote` (default: the default remote). */
export async function pushTag(
  repoId: number,
  name: string,
  remote: string | null = null,
): Promise<void> {
  try {
    const target = await remoteOrDefault(repoId, remote);
    if (target === null) return;
    const result = await unwrap(ipc.commands.pushTag(repoId, target, name));
    toast({
      variant: 'success',
      title: t(result.pushed.length > 0 ? 'network.tag.pushed' : 'network.tag.upToDate', {
        tag: name,
        remote: target,
      }),
      duration: 3000,
    });
  } catch (error) {
    report(repoId, 'push', error);
  }
}

/** Pushes every local tag (F-124, F-201); the remote keeps its tags that are not local. */
export async function pushAllTags(repoId: number, remote: string | null = null): Promise<void> {
  try {
    const target = await remoteOrDefault(repoId, remote);
    if (target === null) return;
    const result = await unwrap(ipc.commands.pushAllTags(repoId, target));
    const count = result.pushed.length;
    toast({
      variant: 'success',
      title:
        count > 0
          ? t('tags.pushAll.done', { count, remote: target })
          : result.upToDate > 0
            ? t('tags.pushAll.upToDate', { remote: target })
            : t('tags.pushAll.none'),
      description: count > 0 ? result.pushed.join(', ') : undefined,
      duration: 3000,
    });
  } catch (error) {
    report(repoId, 'push', error, () => {
      void pushAllTags(repoId, remote);
    });
  }
}

/** `git fetch --tags` of one remote, or of all (`null`): tags off the fetched branches too. */
export async function fetchTags(repoId: number, remote: string | null = null): Promise<boolean> {
  try {
    await unwrap(
      ipc.commands.fetchTags(
        repoId,
        remote === null ? { kind: 'all' } : { kind: 'remote', name: remote },
      ),
    );
    toast({
      variant: 'success',
      title: t('tags.fetch.done'),
      description: repoLabel(repoId),
      duration: 3000,
    });
    return true;
  } catch (error) {
    report(repoId, 'fetch', error, () => {
      void fetchTags(repoId, remote);
    });
    return false;
  } finally {
    refreshRefs(repoId);
  }
}

/** Deletes a tag on `remote` (default: the default remote), after a confirmation. */
export async function deleteRemoteTag(
  repoId: number,
  name: string,
  remote: string | null = null,
): Promise<void> {
  try {
    const target = await remoteOrDefault(repoId, remote);
    if (target === null) return;
    const confirmed = await confirm({
      title: t('network.deleteRemoteTag.title', { tag: name, remote: target }),
      description: t('network.deleteRemoteTag.description', { tag: name, remote: target }),
      command: `git push ${target} --delete refs/tags/${name}`,
      confirmLabel: t('network.deleteRemote.confirm'),
      danger: true,
    });
    if (!confirmed) return;
    await unwrap(ipc.commands.deleteRemoteTag(repoId, target, name));
    toast({
      variant: 'success',
      title: t('network.deleteRemoteTag.done', { tag: name, remote: target }),
      duration: 3000,
    });
  } catch (error) {
    report(repoId, 'push', error);
  }
}

/** Splits `origin/feat/x` on the longest matching remote name. */
export function splitRemoteRef(
  remotes: string[],
  name: string,
): { remote: string; branch: string } | null {
  const remote = [...remotes]
    .sort((a, b) => b.length - a.length)
    .find((r) => name.startsWith(`${r}/`) && name.length > r.length + 1);
  return remote ? { remote, branch: name.slice(remote.length + 1) } : null;
}

export async function deleteRemoteBranch(repoId: number, remoteRef: string): Promise<void> {
  try {
    const split = splitRemoteRef(await unwrap(ipc.commands.listRemotes(repoId)), remoteRef);
    if (!split) return;
    const confirmed = await confirm({
      title: t('network.deleteRemote.title', { target: remoteRef }),
      description: t('network.deleteRemote.description', {
        branch: split.branch,
        remote: split.remote,
      }),
      command: `git push ${split.remote} --delete refs/heads/${split.branch}`,
      confirmLabel: t('network.deleteRemote.confirm'),
      danger: true,
    });
    if (!confirmed) return;
    await unwrap(ipc.commands.deleteRemoteBranch(repoId, split.remote, split.branch));
    toast({
      variant: 'success',
      title: t('network.deleteRemote.done', { target: remoteRef }),
      duration: 3000,
    });
  } catch (error) {
    report(repoId, 'push', error);
  } finally {
    refreshRefs(repoId);
  }
}
