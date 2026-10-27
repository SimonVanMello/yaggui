import { showError } from '../../app/errors/presentError';
import { currentPreferences } from '../../app/preferences';
import { useShellStore } from '../../app/shellStore';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { YagguiIpcError, ipc, unwrap, type GeneratedCommitMessage } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { aiKeys } from '../ai/aiQueries';
import { queryClient } from '../../app/queryClient';
import { shouldOfferRestore, useAiUi, withGenerated, withRestored, canRestore } from './aiMessage';
import { EMPTY_DRAFT, useCommitDrafts } from './commitDraft';
import { useCommitTools } from './commitToolsStore';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** How long the "Restore previous message" toast stays: long enough to read the result first. */
const RESTORE_TOAST_MS = 12_000;

function resultDetail(generated: GeneratedCommitMessage): string {
  const provider = generated.provider === 'claudeApi' ? 'Claude API' : 'Claude Code';
  const seconds = (generated.durationMs / 1000).toFixed(1);
  const base = generated.model
    ? t('commit.ai.generatedModel', { provider, model: generated.model, seconds })
    : t('commit.ai.generatedDetail', { provider, seconds });
  const { context } = generated;
  const reduced = new Set([
    ...context.truncatedFiles,
    ...context.excludedFiles,
    ...context.binaryFiles,
    ...context.omittedFiles,
  ]).size;
  return reduced > 0 ? `${base}\n${t('commit.ai.reduced', { count: reduced })}` : base;
}

/** Puts back the message a generation replaced, unless the user has edited the result since. */
export function restoreAiMessage(repoId: number): void {
  const ui = useAiUi.getState();
  const drafts = useCommitDrafts.getState();
  const draft = drafts.drafts[repoId] ?? EMPTY_DRAFT;
  const restore = ui.restore[repoId];
  if (!canRestore(draft, restore)) {
    toast({ variant: 'info', title: t('commit.ai.restoreStale'), duration: 3000 });
    return;
  }
  const next = withRestored(draft, restore);
  if (!next) return;
  drafts.set(repoId, next);
  ui.setRestore(repoId, null);
  toast({ variant: 'info', title: t('commit.ai.restored'), duration: 2500 });
}

/**
 * Generates the commit message of `repoId` from its staged changes and puts it in the draft
 * (F-072). Never commits. The previous message stays restorable through the toast and the
 * button of the commit area.
 */
export async function generateCommitMessage(repoId: number): Promise<void> {
  const ui = useAiUi.getState();
  if (ui.generating[repoId]) return;
  if (currentPreferences().aiEnabled !== true) {
    useShellStore.getState().setPreferencesOpen(true, 'ai');
    return;
  }
  const amend = (useCommitDrafts.getState().drafts[repoId] ?? EMPTY_DRAFT).amend;
  // The helper's header is asked for; its fields then follow the generated summary.
  const { conventional } = useCommitTools.getState();
  ui.start(repoId);
  try {
    const generated = await unwrap(
      ipc.commands.aiGenerateCommitMessage(repoId, { amend, conventional }),
    );
    const drafts = useCommitDrafts.getState();
    // What the user typed while it ran is what the result replaces.
    const current = drafts.drafts[repoId] ?? EMPTY_DRAFT;
    const message = { summary: generated.summary, description: generated.description };
    const offer = shouldOfferRestore(current, message);
    drafts.set(repoId, withGenerated(current, message));
    useAiUi.getState().setRestore(repoId, offer ? { previous: current, generated: message } : null);
    toast({
      variant: 'success',
      title: t('commit.ai.generated'),
      description: resultDetail(generated),
      duration: offer ? RESTORE_TOAST_MS : 4000,
      action: offer
        ? {
            label: t('commit.ai.restore'),
            onClick: () => {
              restoreAiMessage(repoId);
            },
          }
        : undefined,
    });
  } catch (error) {
    if (error instanceof YagguiIpcError && error.error.code === 'cancelled') return;
    showError(error, {
      title: t('commit.ai.failed'),
      retry: () => {
        void generateCommitMessage(repoId);
      },
    });
    // The status may be why it failed (key revoked, program gone): look again.
    void queryClient.invalidateQueries({ queryKey: aiKeys.status() });
  } finally {
    useAiUi.getState().finish(repoId);
  }
}

/** Stops the generation of `repoId`; its pending call then ends `cancelled`, silently. */
export function cancelGeneration(repoId: number): void {
  void unwrap(ipc.commands.aiCancel(repoId)).catch(showError);
}
