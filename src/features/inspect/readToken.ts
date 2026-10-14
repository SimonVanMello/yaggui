import { ipc } from '../../ipc';

let next = 1;

/**
 * A token for a cancellable backend read (`fileHistory`, `blame`): when TanStack Query aborts
 * the query (unmounted, key changed), the backend stops the Git walk.
 */
export function readToken(signal: AbortSignal): number {
  next = (next % 0x7fff_ffff) + 1;
  const token = next;
  signal.addEventListener(
    'abort',
    () => {
      void ipc.commands.cancelRead(token);
    },
    { once: true },
  );
  return token;
}
