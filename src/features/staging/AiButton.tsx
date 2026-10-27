import { useShellStore } from '../../app/shellStore';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { IconButton } from '../../ui/IconButton';
import { Spinner } from '../../ui/Spinner';
import { useAiAvailability } from '../ai/aiQueries';
import { useShortcut } from '../keybindings/registry';
import { cancelGeneration, generateCommitMessage, restoreAiMessage } from './aiGenerate';
import { canRestore, useAiUi } from './aiMessage';
import styles from './CommitTools.module.css';
import { useCommitDraft } from './commitDraft';

/**
 * Sparkle button of the commit area (F-072): writes the message from the staged changes.
 * Hidden while the feature is off; opens the AI preferences when no provider is ready; shows a
 * spinner with Cancel while it runs, then a button that puts the previous message back.
 */
export function AiButton({ repoId, stagedCount }: { repoId: number; stagedCount: number }) {
  const t = useT();
  const { enabled, ready } = useAiAvailability();
  const shortcut = useShortcut('git.commit.ai');
  const generating = useAiUi((ui) => ui.generating[repoId] === true);
  const restore = useAiUi((ui) => ui.restore[repoId]);
  const draft = useCommitDraft(repoId);
  if (!enabled) return null;

  if (generating) {
    return (
      <span className={styles.aiRunning} role="status">
        <Spinner />
        {t('commit.ai.generating')}
        <Button
          size="sm"
          variant="ghost"
          aria-label={t('commit.ai.cancelAria')}
          onClick={() => {
            cancelGeneration(repoId);
          }}
        >
          {t('commit.ai.cancel')}
        </Button>
      </span>
    );
  }

  const nothingStaged = stagedCount === 0 && !draft.amend;
  const label = !ready
    ? t('commit.ai.setup')
    : nothingStaged
      ? t('commit.ai.nothingStaged')
      : t('commit.ai.generate');
  return (
    <>
      {canRestore(draft, restore) && (
        <IconButton
          size="sm"
          icon="undo"
          label={t('commit.ai.restore')}
          onClick={() => {
            restoreAiMessage(repoId);
          }}
        />
      )}
      <IconButton
        size="sm"
        icon="sparkle"
        label={label}
        shortcut={ready && !nothingStaged ? shortcut : undefined}
        className={styles.ai}
        aria-disabled={ready && nothingStaged}
        onClick={() => {
          if (!ready) useShellStore.getState().setPreferencesOpen(true, 'ai');
          else if (!nothingStaged) void generateCommitMessage(repoId);
        }}
      />
    </>
  );
}
