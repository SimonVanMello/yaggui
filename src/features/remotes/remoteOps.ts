import { confirm } from '../../app/errors/confirmStore';
import { showError, showYagguiError } from '../../app/errors/presentError';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { YagguiIpcError, ipc, unwrap, type YagguiError } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { refreshRefs } from '../refs/refOps';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** Outcome of a remote write shown in a dialog: the error stays there, next to its field. */
export type RemoteResult = { ok: true } | { ok: false; error: YagguiError };

/** Errors about the name, shown under the name field (the others under the URLs). */
export function isNameError(error: YagguiError): boolean {
  return error.code === 'invalidRemoteName' || error.code === 'remoteExists';
}

async function call(repoId: number, work: () => Promise<unknown>): Promise<RemoteResult> {
  try {
    await work();
    return { ok: true };
  } catch (error) {
    if (error instanceof YagguiIpcError) return { ok: false, error: error.error };
    showError(error);
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: {
        code: 'internal',
        message: { en: message, fr: message },
        action: null,
        detail: null,
        payload: null,
      },
    };
  } finally {
    refreshRefs(repoId);
  }
}

export function addRemote(
  repoId: number,
  name: string,
  url: string,
  pushUrl: string | null,
): Promise<RemoteResult> {
  return call(repoId, async () => {
    await unwrap(ipc.commands.addRemote(repoId, name, url, pushUrl));
    toast({ variant: 'success', title: t('remotes.added', { name }), duration: 3000 });
  });
}

/**
 * Saves an edited remote: its URLs first, then its name, so a refused rename leaves the URLs
 * saved and the dialog open on the name.
 */
export function saveRemote(
  repoId: number,
  name: string,
  changes: { newName: string | null; urls: { url: string; pushUrl: string | null } | null },
): Promise<RemoteResult> {
  return call(repoId, async () => {
    if (changes.urls) {
      await unwrap(
        ipc.commands.setRemoteUrls(repoId, name, changes.urls.url, changes.urls.pushUrl),
      );
      toast({ variant: 'success', title: t('remotes.updated', { name }), duration: 3000 });
    }
    if (changes.newName !== null) {
      await unwrap(ipc.commands.renameRemote(repoId, name, changes.newName));
      toast({
        variant: 'success',
        title: t('remotes.renamed', { name, newName: changes.newName }),
        duration: 3000,
      });
    }
  });
}

/** Items listed in the removal confirmation, at most. */
const LISTED = 100;

/**
 * Removes a remote after a confirmation listing what goes with it: its remote-tracking
 * branches, and the upstream of the local branches that follow it. Resolves `true` once removed.
 */
export async function removeRemote(repoId: number, name: string): Promise<boolean> {
  try {
    const preview = await unwrap(ipc.commands.remoteRemovalPreview(repoId, name));
    const count = preview.tracking.length;
    const items = [
      ...preview.tracking.map((branch) => ({
        label: branch,
        note: t('remotes.remove.tracking'),
        danger: true,
      })),
      ...preview.upstreamOf.map((branch) => ({
        label: branch,
        note: t('remotes.remove.upstream'),
      })),
    ];
    const confirmed = await confirm({
      title: t('remotes.remove.title', { name }),
      description:
        count === 0
          ? t('remotes.remove.descriptionEmpty', { name })
          : t('remotes.remove.description', { name, count }),
      command: `git remote remove -- ${name}`,
      confirmLabel: t('remotes.remove.confirm'),
      danger: true,
      items: items.slice(0, LISTED),
      moreItems: items.length > LISTED ? items.length - LISTED : undefined,
    });
    if (!confirmed) return false;
    await unwrap(ipc.commands.removeRemote(repoId, name));
    toast({ variant: 'success', title: t('remotes.removed', { name }), duration: 3000 });
    return true;
  } catch (error) {
    if (error instanceof YagguiIpcError) showYagguiError(error.error);
    else showError(error);
    return false;
  } finally {
    refreshRefs(repoId);
  }
}
