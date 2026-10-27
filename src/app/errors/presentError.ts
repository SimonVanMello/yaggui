import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import {
  YagguiIpcError,
  ipc,
  unwrap,
  type ErrorAction,
  type YagguiError,
  type LocalizedText,
} from '../../ipc';
import { toast, type ToastAction } from '../../ui/toastStore';
import { useCommitUi } from '../../features/staging/commitUi';
import { useShellStore } from '../shellStore';
import { confirm } from './confirmStore';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** Text of a backend message in the current UI language. */
export function localize(text: LocalizedText): string {
  return text[useI18nStore.getState().locale];
}

export interface ErrorContext {
  /** Short summary of what failed ("Could not open the repository"); defaults to the message. */
  title?: string;
  /** Re-runs the failed action, used by the `retry` action and after a successful fix. */
  retry?: () => void;
  /** Pulls then pushes again (`pullThenPush`, offered on a rejected push). */
  pullThenPush?: () => void;
  /** Pushes again creating the upstream (`pushSetUpstream`). */
  pushSetUpstream?: () => void;
}

export interface ResolvedErrorAction {
  label: string;
  run: () => void;
}

/**
 * Turns the action suggested by a typed error into a label and a handler, or `null` when it
 * cannot be offered in this context (e.g. `retry` without a retry function).
 */
export function resolveErrorAction(
  action: ErrorAction | null,
  context: ErrorContext = {},
): ResolvedErrorAction | null {
  if (!action) return null;
  const { retry } = context;
  switch (action.kind) {
    case 'retry':
      return retry ? { label: t('error.action.retry'), run: retry } : null;
    case 'refresh':
      return retry ? { label: t('error.action.refresh'), run: retry } : null;
    case 'configureIdentity': {
      const { repoId } = action;
      if (repoId === null) return null;
      return {
        label: t('error.action.configureIdentity'),
        run: () => {
          useCommitUi.getState().setIdentity(repoId, true);
        },
      };
    }
    case 'pullThenPush':
      return context.pullThenPush
        ? { label: t('error.action.pullThenPush'), run: context.pullThenPush }
        : null;
    case 'pushSetUpstream':
      return context.pushSetUpstream
        ? { label: t('error.action.pushSetUpstream'), run: context.pushSetUpstream }
        : null;
    // Needs the deletion request: offered by the dialog that made it.
    case 'forceDelete':
      return null;
    case 'openCommandLog':
      return {
        label: t('error.action.openCommandLog'),
        run: () => {
          useShellStore.getState().showLogEntry(null);
        },
      };
    case 'addSafeDirectory':
      return {
        label: t('error.action.addSafeDirectory'),
        run: () => {
          void (async () => {
            const confirmed = await confirm({
              title: t('error.safeDirectory.title'),
              description: t('error.safeDirectory.description', { path: action.path }),
              command: `git config --global --add safe.directory ${action.path}`,
              confirmLabel: t('error.safeDirectory.confirm'),
            });
            if (!confirmed) return;
            try {
              await unwrap(ipc.commands.addSafeDirectory(action.path));
              retry?.();
            } catch (err) {
              showError(err);
            }
          })();
        },
      };
    case 'removeIndexLock': {
      const { repoId } = action;
      if (repoId === null) return null;
      return {
        label: t('error.action.removeIndexLock'),
        run: () => {
          void (async () => {
            const confirmed = await confirm({
              title: t('error.indexLock.title'),
              description: t('error.indexLock.description', { path: action.path }),
              confirmLabel: t('error.indexLock.confirm'),
              danger: true,
            });
            if (!confirmed) return;
            try {
              await unwrap(ipc.commands.removeStaleIndexLock(repoId, action.path));
              toast({ variant: 'success', title: t('error.indexLock.removed') });
              retry?.();
            } catch (err) {
              showError(err);
            }
          })();
        },
      };
    }
    case 'configureTerminal':
      return {
        label: t('error.action.configureTerminal'),
        run: () => {
          useShellStore.getState().setTerminalDialogOpen(true);
        },
      };
    case 'installGit':
      return {
        label: t('error.action.installGit'),
        run: () => {
          void confirm({
            title: t('error.installGit.title'),
            description: t('error.installGit.description'),
            confirmLabel: t('common.ok'),
          });
        },
      };
  }
}

/** Shows a typed backend error as a persistent toast with its suggested action (F-301). */
export function showYagguiError(error: YagguiError, context: ErrorContext = {}): number {
  const action = resolveErrorAction(error.action, context);
  const toastAction: ToastAction | undefined = action
    ? { label: action.label, onClick: action.run }
    : undefined;
  const message = localize(error.message);
  return toast({
    variant: 'error',
    title: context.title ?? message,
    description: context.title ? message : undefined,
    detail: error.detail ?? undefined,
    action: toastAction,
  });
}

/** Shows any thrown value: typed errors get their action, other errors a generic message. */
export function showError(error: unknown, context: ErrorContext = {}): void {
  if (error instanceof YagguiIpcError) {
    showYagguiError(error.error, context);
    return;
  }
  console.error(error);
  toast({
    variant: 'error',
    title: context.title ?? t('error.unexpected'),
    detail: error instanceof Error ? error.message : String(error),
  });
}
