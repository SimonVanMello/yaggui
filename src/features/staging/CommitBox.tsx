import { useEffect, useRef, useState } from 'react';

import { queryClient } from '../../app/queryClient';
import { showError } from '../../app/errors/presentError';
import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { YagguiIpcError, ipc, unwrap, type RepoState } from '../../ipc';
import { Button } from '../../ui/Button';
import { Kbd } from '../../ui/Kbd';
import { useShortcut } from '../keybindings/registry';
import { toast } from '../../ui/toastStore';
import { shortSha } from '../diff/format';
import { pushRepo } from '../network/networkOps';
import { useOpsStore } from '../repo/opsStore';
import { activeRepoId } from '../repo/repoSessions';
import { workingBranch } from '../repo/repoStatus';
import { useAiUi } from './aiMessage';
import styles from './CommitBox.module.css';
import {
  commitBlock,
  SUMMARY_LIMIT,
  summaryLength,
  summaryLevel,
  useCommitDraft,
  useCommitDrafts,
  withAmend,
} from './commitDraft';
import { CommitIdentity } from './CommitIdentity';
import { commitToolsKeys } from './commitToolsOps';
import { useCommitTools } from './commitToolsStore';
import { COMMIT_EVENT, useCommitUi } from './commitUi';
import { ConventionalFields } from './ConventionalFields';
import { HookFailurePanel } from './HookFailurePanel';
import { IdentityForm } from './IdentityForm';
import { MessageTools } from './MessageTools';
import { refreshWorktree, reportWriteError } from './stagingActions';

/**
 * Commit area of the right panel (F-064, F-065): summary with a 72-character counter,
 * description, amend, and `⌘↵` / `Ctrl+↵` to commit. A hook rejection shows its full output;
 * a missing Git identity opens a small form. Message helpers (templates, Conventional Commits,
 * recent messages), identity profiles and the signing state come from M4-7a.
 */
export function CommitBox({ repoId, state }: { repoId: number; state: RepoState }) {
  const t = useT();
  const commitShortcut = useShortcut('git.commit');
  const draft = useCommitDraft(repoId);
  const failure = useCommitUi((ui) => ui.hook[repoId]);
  const identityOpen = useCommitUi((ui) => ui.identity[repoId] === true);
  const conventional = useCommitTools((tools) => tools.conventional);
  const [pending, setPending] = useState(false);
  const running = useOpsStore((ops) =>
    Object.values(ops.running).some((op) => op?.repoId === repoId && op.kind === 'commit'),
  );
  const summaryRef = useRef<HTMLInputElement>(null);
  const branch = workingBranch(state);

  const busy = pending || running;
  const block = commitBlock(draft, { stagedCount: state.dirty.staged, busy });
  const length = summaryLength(draft.summary);
  const level = summaryLevel(draft.summary);

  const update = useCommitDrafts.getState().update;
  const [pushAfter, setPushAfter] = useState(false);

  const submit = async () => {
    const current = useCommitDrafts.getState().drafts[repoId];
    if (!current || commitBlock(current, { stagedCount: state.dirty.staged, busy }) !== null) {
      summaryRef.current?.focus();
      return;
    }
    const ui = useCommitUi.getState();
    ui.setHook(repoId, null);
    setPending(true);
    try {
      const result = await unwrap(
        ipc.commands.commit(repoId, {
          summary: current.summary.trim(),
          description: current.description.trimEnd(),
          amend: current.amend,
          skipHooks: false,
        }),
      );
      useCommitDrafts.getState().clear(repoId);
      useAiUi.getState().setRestore(repoId, null);
      void queryClient.invalidateQueries({ queryKey: commitToolsKeys.recent(repoId) });
      toast({
        variant: 'success',
        title: t(current.amend ? 'commit.amended' : 'commit.created', {
          sha: shortSha(result.sha),
        }),
        duration: 3000,
      });
      summaryRef.current?.focus();
      if (pushAfter) void pushRepo(repoId);
    } catch (error) {
      if (error instanceof YagguiIpcError) {
        const { code, payload } = error.error;
        if (code === 'hookFailed' && payload?.kind === 'hook') {
          ui.setHook(repoId, { ...payload, message: localize(error.error.message) });
          return;
        }
        if (code === 'identityUnknown') {
          ui.setIdentity(repoId, true);
          return;
        }
        if (code === 'cancelled') return;
      }
      reportWriteError(error);
    } finally {
      setPending(false);
      refreshWorktree(repoId);
    }
  };

  // Kept in a ref: the window listeners below always call the latest closure.
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  });
  useEffect(() => {
    const run = () => {
      if (activeRepoId() === repoId) void submitRef.current();
    };
    // The keyboard shortcut reaches us as COMMIT_EVENT, from the global handler (F-281).
    window.addEventListener(COMMIT_EVENT, run);
    return () => {
      window.removeEventListener(COMMIT_EVENT, run);
    };
  }, [repoId]);

  const toggleAmend = (amend: boolean) => {
    const drafts = useCommitDrafts.getState();
    const current = drafts.drafts[repoId] ?? draft;
    if (!amend) {
      drafts.set(repoId, withAmend(current, false, null));
      return;
    }
    // Show the amend right away; the message follows once HEAD's has been read.
    drafts.set(repoId, withAmend(current, true, null));
    void unwrap(ipc.commands.lastCommitMessage(repoId))
      .then((last) => {
        const now = useCommitDrafts.getState().drafts[repoId];
        if (now?.amend) drafts.set(repoId, withAmend({ ...now, amend: false }, true, last));
      })
      .catch(showError);
  };

  const hint =
    block === 'noSummary'
      ? t('commit.hint.noSummary')
      : block === 'nothingStaged'
        ? t('commit.hint.nothingStaged')
        : null;
  const label = draft.amend
    ? t('commit.amendButton')
    : branch
      ? t('changes.commitOn', { branch })
      : t('changes.commit');

  return (
    <div className={styles.box}>
      {failure && (
        <HookFailurePanel
          failure={failure}
          onDismiss={() => {
            useCommitUi.getState().setHook(repoId, null);
          }}
        />
      )}
      {identityOpen && (
        <IdentityForm
          repoId={repoId}
          onDone={(saved) => {
            useCommitUi.getState().setIdentity(repoId, false);
            if (saved) {
              void queryClient.invalidateQueries({ queryKey: commitToolsKeys.identity(repoId) });
              toast({ variant: 'success', title: t('identity.saved'), duration: 3000 });
              void submitRef.current();
            } else {
              summaryRef.current?.focus();
            }
          }}
        />
      )}
      <MessageTools repoId={repoId} stagedCount={state.dirty.staged} />
      {conventional && <ConventionalFields repoId={repoId} />}
      <div className={styles.summary} data-level={level}>
        <input
          ref={summaryRef}
          className={styles.input}
          value={draft.summary}
          placeholder={t('changes.summaryPlaceholder')}
          aria-label={t('changes.summaryPlaceholder')}
          aria-describedby={`summary-count-${String(repoId)}`}
          spellCheck
          onChange={(event) => {
            update(repoId, { summary: event.target.value });
          }}
        />
        <span
          id={`summary-count-${String(repoId)}`}
          className={styles.counter}
          data-level={level}
          title={
            level === 'over' ? t('commit.summaryTooLong', { limit: SUMMARY_LIMIT }) : undefined
          }
        >
          {length}/{SUMMARY_LIMIT}
        </span>
      </div>
      {level === 'over' && (
        <p className={styles.warning} role="status">
          {t('commit.summaryTooLong', { limit: SUMMARY_LIMIT })}
        </p>
      )}
      <textarea
        className={styles.description}
        value={draft.description}
        rows={3}
        placeholder={t('commit.descriptionPlaceholder')}
        aria-label={t('commit.descriptionPlaceholder')}
        onChange={(event) => {
          update(repoId, { description: event.target.value });
        }}
      />
      <div className={styles.options}>
        <label className={styles.option}>
          <input
            type="checkbox"
            checked={draft.amend}
            onChange={(event) => {
              toggleAmend(event.target.checked);
            }}
          />
          {t('commit.amend')}
        </label>
        <label className={styles.option}>
          <input
            type="checkbox"
            checked={pushAfter}
            onChange={(event) => {
              setPushAfter(event.target.checked);
            }}
          />
          {t('commit.pushAfter')}
        </label>
      </div>
      <CommitIdentity repoId={repoId} />
      <Button
        variant="primary"
        className={styles.commit}
        aria-disabled={block !== null}
        aria-describedby={hint ? `commit-hint-${String(repoId)}` : undefined}
        onClick={() => {
          void submit();
        }}
      >
        {busy ? t('commit.committing') : label}
        {commitShortcut && <Kbd shortcut={commitShortcut} />}
      </Button>
      {hint && (
        <p id={`commit-hint-${String(repoId)}`} className={styles.hint}>
          {hint}
        </p>
      )}
    </div>
  );
}
