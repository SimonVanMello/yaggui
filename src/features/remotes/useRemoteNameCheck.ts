import { ipc, unwrap } from '../../ipc';
import { useNameCheck, type NameCheck } from '../refs/useRefNameCheck';

/** Live verdict on a new remote name: `invalidRemoteName`, `remoteExists` or available. */
export function useRemoteNameCheck(repoId: number, name: string, skip = false): NameCheck {
  return useNameCheck(`remote:${String(repoId)}`, name, skip, (value) =>
    unwrap(ipc.commands.validateRemoteName(repoId, value)),
  );
}
