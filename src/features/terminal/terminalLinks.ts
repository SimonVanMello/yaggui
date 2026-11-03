import { showYagguiError } from '../../app/errors/presentError';
import { ipc } from '../../ipc';
import type { Platform } from '../../ui/platform';

/**
 * A plain click in the terminal belongs to the shell (selection, mouse reporting): a link
 * opens on ⌘-click on macOS, Ctrl-click elsewhere, as in VS Code and most terminals.
 */
export function isLinkClick(event: MouseEvent, platform: Platform): boolean {
  return platform === 'mac' ? event.metaKey : event.ctrlKey;
}

/** Same rule as the backend: the output of any program can carry a link. */
export function isWebLink(uri: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(uri);
}

export async function openTerminalLink(uri: string): Promise<void> {
  if (!isWebLink(uri)) return;
  const result = await ipc.commands.openLink(uri);
  if (result.status === 'error') showYagguiError(result.error);
}
