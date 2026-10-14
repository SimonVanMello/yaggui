import { useQuery, useQueryClient } from '@tanstack/react-query';

import { showYagguiError } from '../../app/errors/presentError';
import { translate, useI18nStore } from '../../i18n/i18n';
import { YagguiIpcError, ipc, unwrap, type ConfigEntry, type ConfigScope } from '../../ipc';

const root = ['git-config'] as const;

function key(scope: ConfigScope, repoId: number | null) {
  return [...root, scope, scope === 'repo' ? repoId : null] as const;
}

/** Entries of one Git config file; `repoId` is needed for the repository scope. */
export function useConfigEntries(scope: ConfigScope, repoId: number | null) {
  return useQuery<ConfigEntry[]>({
    queryKey: key(scope, repoId),
    queryFn: () => unwrap(ipc.commands.gitConfigList(repoId, scope)),
    enabled: scope === 'global' || repoId !== null,
  });
}

/** Sets (or, with `null`, removes) a key; a failure is shown and returned as `false`. */
export function useConfigWriter(scope: ConfigScope, repoId: number | null) {
  const client = useQueryClient();
  return async (name: string, value: string | null): Promise<boolean> => {
    try {
      await unwrap(ipc.commands.gitConfigSet(repoId, scope, name, value));
    } catch (failure) {
      if (failure instanceof YagguiIpcError) {
        const locale = useI18nStore.getState().locale;
        showYagguiError(failure.error, { title: translate(locale, 'gitconfig.saveFailed') });
        return false;
      }
      throw failure;
    } finally {
      await client.invalidateQueries({ queryKey: root });
    }
    // The commit box asks for an identity when none is configured: it may be set now.
    void client.invalidateQueries({ queryKey: ['git-identity'] });
    return true;
  };
}
