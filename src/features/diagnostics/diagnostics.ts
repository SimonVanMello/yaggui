import { showYagguiError } from '../../app/errors/presentError';
import { translate, useI18nStore, type MessageKey } from '../../i18n/i18n';
import { ipc } from '../../ipc';
import { toast } from '../../ui/toastStore';

function t(key: MessageKey): string {
  return translate(useI18nStore.getState().locale, key);
}

export async function openLogsFolder(): Promise<void> {
  const result = await ipc.commands.openLogsFolder();
  if (result.status === 'error') showYagguiError(result.error);
}

/** Puts the diagnostic report on the clipboard; `true` once it is there. */
async function writeReport(): Promise<boolean> {
  const result = await ipc.commands.bugReport();
  if (result.status === 'error') {
    showYagguiError(result.error);
    return false;
  }
  try {
    await navigator.clipboard.writeText(result.data);
    return true;
  } catch (error) {
    console.warn('Could not copy the diagnostic report', error);
    toast({ variant: 'error', title: t('diagnostics.copyFailed') });
    return false;
  }
}

export async function copyBugReport(): Promise<void> {
  if (!(await writeReport())) return;
  toast({
    variant: 'success',
    title: t('diagnostics.copied'),
    description: t('diagnostics.review'),
  });
}

/** Copies the report, then opens the bug form of the issue tracker, where the user pastes it. */
export async function reportBug(): Promise<void> {
  const copied = await writeReport();
  const result = await ipc.commands.openIssueTracker();
  if (result.status === 'error') {
    showYagguiError(result.error);
    return;
  }
  if (copied) {
    toast({
      title: t('diagnostics.reportCopied'),
      description: t('diagnostics.review'),
      duration: 10_000,
    });
  }
}

/**
 * Tells once about the crash reports of earlier sessions: a panic on a background thread does
 * not stop the app, the user may never have noticed it.
 */
export async function notifyPendingCrashes(): Promise<void> {
  const result = await ipc.commands.pendingCrashReports();
  if (result.status === 'error') {
    console.warn('Crash reports unavailable', result.error);
    return;
  }
  const latest = result.data.at(-1);
  if (!latest) return;
  toast({
    variant: 'warning',
    title: t('diagnostics.crashed'),
    description: latest.message || undefined,
    action: { label: t('diagnostics.report'), onClick: () => void reportBug() },
    duration: Infinity,
  });
  const acknowledged = await ipc.commands.acknowledgeCrashReports();
  if (acknowledged.status === 'error') {
    console.warn('Crash reports not acknowledged', acknowledged.error);
  }
}

export type FrontendErrorKind = 'render' | 'error' | 'rejection';

/** A broken render loop must not flood the log: each message once, this many in all. */
export const MAX_FORWARDED_ERRORS = 50;
const forwarded = new Set<string>();

function describe(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    return { message: `${error.name}: ${error.message}`, stack: error.stack ?? null };
  }
  return { message: String(error), stack: null };
}

/** Writes an uncaught error to the session log of the backend. */
export function forwardFrontendError(
  kind: FrontendErrorKind,
  error: unknown,
  extraStack?: string,
): void {
  const { message, stack } = describe(error);
  const key = `${kind}\u0000${message}`;
  if (forwarded.has(key) || forwarded.size >= MAX_FORWARDED_ERRORS) return;
  forwarded.add(key);
  const fullStack = [stack, extraStack].filter(Boolean).join('\n') || null;
  ipc.commands.logFrontendError(kind, message, fullStack).catch((reason: unknown) => {
    console.warn('Could not log a frontend error', reason);
  });
}

/** Tests only. */
export function resetForwardedErrors(): void {
  forwarded.clear();
}

function onError(event: ErrorEvent): void {
  forwardFrontendError('error', event.error ?? event.message);
}

function onRejection(event: PromiseRejectionEvent): void {
  forwardFrontendError('rejection', event.reason);
}

/** Forwards the errors nothing caught; returns the uninstaller. */
export function installErrorForwarding(): () => void {
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
