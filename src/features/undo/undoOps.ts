import { confirm, type ConfirmItem } from '../../app/errors/confirmStore';
import { localize, showError, showYagguiError } from '../../app/errors/presentError';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { YagguiIpcError, ipc, unwrap, type YagguiError, type JournalEntry } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { stashPush } from '../refs/refOps';
import { invalidateJournal } from './undoQueries';
import { opMessage, shortRef, type Message } from './undoLabels';
import type { UndoDirection } from './undoState';

const ITEMS_MAX = 12;

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

export function text(message: Message): string {
  return t(message.key, message.params).trim();
}

/** "commit "fix: login"" for an entry, in the current language. */
export function entryText(entry: JournalEntry): string {
  return text(opMessage(entry.op));
}

/** Undo and redo of one repository never overlap: a second ⌘Z waits for the first answer. */
const running = new Set<number>();

function toItems(error: YagguiError): { items: ConfirmItem[]; moreItems: number } {
  const refs = error.payload?.kind === 'undoChanges' ? error.payload.refs : [];
  const paths = error.payload?.kind === 'undoChanges' ? error.payload.paths : [];
  const all: ConfirmItem[] = [
    ...refs.map((ref) => ({ label: shortRef(ref), note: t('undo.changes.ref') })),
    ...paths.map((path) => ({ label: path, note: t('undo.changes.file') })),
  ];
  return { items: all.slice(0, ITEMS_MAX), moreItems: Math.max(0, all.length - ITEMS_MAX) };
}

/** `undoDiverged`: nothing can be done from here, so the dialog only explains what moved. */
async function explainDiverged(error: YagguiError, direction: UndoDirection): Promise<void> {
  await confirm({
    title: t(direction === 'undo' ? 'undo.diverged.title' : 'redo.diverged.title'),
    description: t('undo.diverged.description'),
    confirmLabel: t('common.ok'),
    informational: true,
    ...toItems(error),
  });
}

/** `undoWouldOverwrite`: shows what is in the way and offers to stash it, then retries. */
async function confirmOverwrite(
  repoId: number,
  error: YagguiError,
  direction: UndoDirection,
): Promise<void> {
  const confirmed = await confirm({
    title: t(direction === 'undo' ? 'undo.overwrite.title' : 'redo.overwrite.title'),
    description: t('undo.overwrite.description'),
    confirmLabel: t('undo.overwrite.confirm'),
    command: 'git stash push --include-untracked',
    ...toItems(error),
  });
  if (!confirmed) return;
  const stashed = await stashPush(repoId, {
    message: null,
    includeUntracked: true,
    keepIndex: false,
  });
  if (stashed.ok) await runUndo(repoId, direction);
  else if (!stashed.handled) showYagguiError(stashed.error);
}

async function present(repoId: number, error: YagguiError, direction: UndoDirection) {
  switch (error.code) {
    case 'nothingToUndo':
    case 'nothingToRedo':
      invalidateJournal(repoId);
      toast({ variant: 'info', title: localize(error.message) });
      return;
    case 'undoBlocked':
      toast({
        variant: 'warning',
        title: t(direction === 'undo' ? 'undo.blocked.title' : 'redo.blocked.title'),
        description: localize(error.message),
      });
      return;
    case 'undoDiverged':
      invalidateJournal(repoId);
      await explainDiverged(error, direction);
      return;
    case 'undoWouldOverwrite':
      await confirmOverwrite(repoId, error, direction);
      return;
    default:
      showYagguiError(error);
  }
}

/**
 * Undoes (or redoes) the latest journaled operation of a repository and reports the outcome:
 * a toast on success, an explanation or a confirmation when it is refused. Returns whether
 * it went through.
 */
export async function runUndo(repoId: number, direction: UndoDirection): Promise<boolean> {
  if (running.has(repoId)) return false;
  running.add(repoId);
  try {
    const command = direction === 'undo' ? ipc.commands.undo : ipc.commands.redo;
    const entry = await unwrap(command(repoId));
    toast({
      variant: 'success',
      title: t(direction === 'undo' ? 'undo.done' : 'redo.done', { op: entryText(entry) }),
    });
    invalidateJournal(repoId);
    return true;
  } catch (error) {
    if (error instanceof YagguiIpcError) {
      // Released first: a confirmation may retry the same command.
      running.delete(repoId);
      await present(repoId, error.error, direction);
    } else {
      showError(error);
    }
    return false;
  } finally {
    running.delete(repoId);
  }
}
