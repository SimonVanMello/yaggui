import { queryClient, queryKeys } from '../../app/queryClient';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { YagguiIpcError, ipc, unwrap, type GitignoreRuleKind, type YagguiError } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { refreshRefs } from '../refs/refOps';
import { useCommitDrafts } from './commitDraft';
import { reportWriteError } from './stagingActions';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

export const commitToolsKeys = {
  settings: (repoId: number) => ['commit-settings', repoId] as const,
  recent: (repoId: number) => ['recent-commit-messages', repoId] as const,
  templates: () => ['commit-templates'] as const,
  profiles: () => ['identity-profiles'] as const,
  identity: (repoId: number) => ['git-identity', repoId] as const,
  signature: (repoId: number, sha: string) => ['commit-signature', repoId, sha] as const,
};

/** Puts a whole message (summary line, blank line, description) in the draft. */
export function fillDraft(repoId: number, message: string): void {
  const [summary = '', ...rest] = message.split('\n');
  const description = rest.join('\n').replace(/^\n+/, '').trimEnd();
  useCommitDrafts.getState().update(repoId, { summary, description });
}

type Outcome<T> = { ok: true; data: T } | { ok: false; error: YagguiError | null };

async function attempt<T>(work: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    reportWriteError(error);
    return { ok: false, error: error instanceof YagguiIpcError ? error.error : null };
  }
}

/** Appends a rule to `.gitignore` (undoable). */
export async function addToGitignore(
  repoId: number,
  path: string,
  kind: GitignoreRuleKind,
): Promise<Outcome<string>> {
  const result = await attempt(() => unwrap(ipc.commands.addToGitignore(repoId, path, kind)));
  refreshRefs(repoId);
  if (result.ok) {
    toast({
      variant: 'success',
      title: t('gitignore.added', { rule: result.data }),
      duration: 3000,
    });
  }
  return result;
}

/** `git stash push -- <paths>` (undoable). */
export async function stashFiles(
  repoId: number,
  paths: string[],
  message: string,
  includeUntracked: boolean,
): Promise<Outcome<null>> {
  const result = await attempt(() =>
    unwrap(
      ipc.commands.stashPushPaths(repoId, {
        paths,
        message: message.trim() || null,
        includeUntracked,
      }),
    ),
  );
  refreshRefs(repoId);
  if (!result.ok) return result;
  toast({
    variant: 'success',
    title: t('stashFiles.done', { count: paths.length }),
    duration: 3000,
  });
  return { ok: true, data: null };
}

/** Writes a profile's name and email to the repository config (`git config --local`). */
export async function applyProfile(
  repoId: number,
  profile: { label: string; name: string; email: string },
): Promise<boolean> {
  const result = await attempt(() =>
    unwrap(ipc.commands.setGitIdentity(repoId, profile.name, profile.email, 'repo')),
  );
  void queryClient.invalidateQueries({ queryKey: commitToolsKeys.identity(repoId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.repoState(repoId) });
  if (result.ok) {
    toast({
      variant: 'success',
      title: t('identity.profile.applied', { label: profile.label }),
      duration: 3000,
    });
  }
  return result.ok;
}
