import { useState } from 'react';

import { useT } from '../../i18n/useT';
import type { MergeMode } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { useRepoRefs } from '../sidebar/useRepoRefs';
import { BranchSelect, branchOptions } from './BranchSelect';
import { ChoiceList, type Choice } from './ChoiceList';
import { useHistoryDialogs, type HistoryDialog } from './historyDialogsStore';
import { currentBranchOf, mergeBranch } from './historyOps';
import { rememberMergeMode, rememberedMergeMode, type MergeChoice } from './mergePreference';
import refStyles from '../refs/RefDialogs.module.css';
import styles from './HistoryDialogs.module.css';

type Props = Extract<HistoryDialog, { kind: 'merge' }>;

const FLAGS: Record<MergeMode, string> = {
  fastForward: '--ff',
  fastForwardOnly: '--ff-only',
  noFastForward: '--no-ff',
  squash: '--squash',
};

/**
 * Merge of a branch into another (F-140, F-026): fast-forward when possible, always a merge
 * commit, or squash. The choice is remembered for the next merge.
 */
export function MergeDialog({
  repoId,
  source: initialSource,
  target: initialTarget,
  mode: forced,
}: Props) {
  const t = useT();
  const close = useHistoryDialogs((state) => state.close);
  const refs = useRepoRefs(repoId).data;
  const current = currentBranchOf(repoId);
  const target = initialTarget ?? current;
  const [source, setSource] = useState(initialSource ?? '');
  const [choice, setChoice] = useState<MergeChoice>(rememberedMergeMode);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const mode: MergeMode = forced ?? choice;
  const targetLabel = target ?? 'HEAD';

  const choices: Choice<MergeChoice>[] = [
    {
      value: 'fastForward',
      title: t('history.merge.mode.ff'),
      help: t('history.merge.mode.ffHelp', { target: targetLabel }),
    },
    {
      value: 'noFastForward',
      title: t('history.merge.mode.noFf'),
      help: t('history.merge.mode.noFfHelp'),
    },
    {
      value: 'squash',
      title: t('history.merge.mode.squash'),
      help: t('history.merge.mode.squashHelp', { target: targetLabel }),
    },
  ];

  const submit = () => {
    if (busy || source === '') return;
    setBusy(true);
    if (!forced) rememberMergeMode(choice);
    void mergeBranch(repoId, {
      source,
      target: initialTarget,
      mode,
      message: mode === 'noFastForward' || mode === 'squash' ? message.trim() || null : null,
    }).finally(close);
  };

  const needsMessage = mode === 'noFastForward' || mode === 'squash';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={
        forced
          ? t('history.merge.ffTitle', { source: source || '…', target: targetLabel })
          : t('history.merge.title', { source: source || '…', target: targetLabel })
      }
      description={forced ? t('history.merge.ffText') : t('history.merge.text')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" aria-disabled={busy || source === ''} onClick={submit}>
            {forced ? t('history.merge.ffConfirm') : t('history.merge.confirm')}
          </Button>
        </>
      }
    >
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {initialSource === null && (
          <BranchSelect
            label={t('history.merge.source')}
            value={source}
            options={branchOptions(refs, [target], true)}
            onChange={setSource}
          />
        )}
        {!forced && (
          <ChoiceList
            label={t('history.merge.modeLabel')}
            value={choice}
            choices={choices}
            onChange={setChoice}
          />
        )}
        {needsMessage && (
          <div className={styles.field}>
            <label htmlFor="merge-message">{t('history.merge.message')}</label>
            <textarea
              id="merge-message"
              className={styles.textarea}
              value={message}
              placeholder={t('history.merge.messagePlaceholder')}
              onChange={(event) => {
                setMessage(event.target.value);
              }}
            />
          </div>
        )}
        {target !== current && (
          <p className={styles.summary}>{t('history.checkoutFirst', { target: targetLabel })}</p>
        )}
        <code className={refStyles.command}>
          {`${target !== current && target ? `git checkout ${target}\n` : ''}git merge ${FLAGS[mode]} ${source || '<branch>'}`}
        </code>
      </form>
    </Dialog>
  );
}
