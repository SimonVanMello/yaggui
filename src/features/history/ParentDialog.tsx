import { useQueries } from '@tanstack/react-query';
import { useState } from 'react';

import { useT } from '../../i18n/useT';
import { ipc, unwrap } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Spinner } from '../../ui/Spinner';
import refStyles from '../refs/RefDialogs.module.css';
import { shortOid } from '../repo/repoStatus';
import { ChoiceList, type Choice } from './ChoiceList';
import { useHistoryDialogs, type HistoryDialog } from './historyDialogsStore';
import { cherryPickCommits, revertCommit } from './historyOps';
import styles from './HistoryDialogs.module.css';

type Props = Extract<HistoryDialog, { kind: 'parent' }>;

/**
 * Revert or cherry-pick of a merge commit (F-144): Git needs to know which parent is the
 * mainline, i.e. which side of the merge is kept.
 */
export function ParentDialog({ repoId, op, shas, target }: Props) {
  const t = useT();
  const close = useHistoryDialogs((state) => state.close);
  const details = useQueries({
    queries: shas.map((sha) => ({
      queryKey: ['commit-detail', repoId, sha],
      queryFn: () => unwrap(ipc.commands.commitDetail(repoId, sha)),
      staleTime: Infinity,
    })),
  });
  const merge = details
    .map((query) => query.data)
    .find((detail) => (detail?.parents.length ?? 0) > 1);
  const parents = merge?.parents ?? [];
  const parentDetails = useQueries({
    queries: parents.map((sha) => ({
      queryKey: ['commit-detail', repoId, sha],
      queryFn: () => unwrap(ipc.commands.commitDetail(repoId, sha)),
      staleTime: Infinity,
    })),
  });
  const [parent, setParent] = useState('1');
  const [busy, setBusy] = useState(false);

  const choices: Choice<string>[] = parents.map((sha, index) => {
    const summary = parentDetails[index]?.data?.summary ?? '';
    return {
      value: String(index + 1),
      title: (
        <>
          {t('history.parent.option', { n: index + 1 })}{' '}
          <span className={styles.parentSha}>{shortOid(sha)}</span>
        </>
      ),
      help:
        (index === 0 ? t('history.parent.first') : t('history.parent.other')) +
        (summary ? ` — ${summary}` : ''),
    };
  });

  const submit = () => {
    if (busy || !merge) return;
    setBusy(true);
    const mainline = Number(parent);
    const work =
      op === 'revert'
        ? revertCommit(repoId, shas[0] ?? merge.sha, mainline)
        : cherryPickCommits(repoId, { shas, target, mainline });
    void work.finally(close);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t(op === 'revert' ? 'history.parent.revertTitle' : 'history.parent.pickTitle', {
        sha: shortOid(merge?.sha ?? shas[0] ?? ''),
      })}
      description={t(op === 'revert' ? 'history.parent.revertText' : 'history.parent.pickText')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" aria-disabled={busy || !merge} onClick={submit}>
            {t(op === 'revert' ? 'history.parent.revertConfirm' : 'history.parent.pickConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        {!merge && (
          <p className={styles.summary} role="status">
            <Spinner /> {t('history.parent.loading')}
          </p>
        )}
        {merge && (
          <ChoiceList
            label={t('history.parent.label')}
            value={parent}
            choices={choices}
            onChange={setParent}
          />
        )}
        <code className={refStyles.command}>
          {op === 'revert'
            ? `git revert -m ${parent} ${shortOid(shas[0] ?? '')}`
            : `git cherry-pick -m ${parent} ${shas.map(shortOid).join(' ')}`}
        </code>
      </div>
    </Dialog>
  );
}
