import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { YagguiIpcError, ipc, unwrap, type LostChange, type ResetMode } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Spinner } from '../../ui/Spinner';
import refStyles from '../refs/RefDialogs.module.css';
import { ChoiceList, type Choice } from './ChoiceList';
import { useHistoryDialogs, type HistoryDialog } from './historyDialogsStore';
import { resetBranch } from './historyOps';
import styles from './HistoryDialogs.module.css';

type Props = Extract<HistoryDialog, { kind: 'reset' }>;

const CHANGE_KEYS = {
  modified: 'history.reset.lost.modified',
  added: 'history.reset.lost.added',
  deleted: 'history.reset.lost.deleted',
  untracked: 'history.reset.lost.untracked',
} as const satisfies Record<LostChange, string>;

/**
 * Reset of the current branch to a commit (F-145): each mode says what it keeps and what it
 * loses, and `hard` lists the files whose local content disappears (`resetPreview`).
 */
export function ResetDialog({ repoId, target, label, mode: initialMode }: Props) {
  const t = useT();
  const close = useHistoryDialogs((state) => state.close);
  const [mode, setMode] = useState<ResetMode>(initialMode ?? 'mixed');
  const [busy, setBusy] = useState(false);
  const preview = useQuery({
    queryKey: ['reset-preview', repoId, target],
    queryFn: () => unwrap(ipc.commands.resetPreview(repoId, target)),
    staleTime: 0,
    gcTime: 0,
  });
  const data = preview.data;
  const branch = data?.branch ?? 'HEAD';

  const choices: Choice<ResetMode>[] = [
    {
      value: 'soft',
      title: t('history.reset.soft'),
      help: t('history.reset.softHelp', { branch }),
    },
    {
      value: 'mixed',
      title: t('history.reset.mixed'),
      help: t('history.reset.mixedHelp'),
    },
    {
      value: 'hard',
      title: t('history.reset.hard'),
      help: t('history.reset.hardHelp'),
      danger: true,
    },
  ];

  const lost = mode === 'hard' ? (data?.hardLost ?? []) : [];
  const submit = () => {
    if (busy || !data) return;
    setBusy(true);
    void resetBranch(repoId, target, mode).finally(close);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('history.reset.title', { branch, label })}
      description={t('history.reset.text')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={mode === 'hard' ? 'danger' : 'primary'}
            aria-disabled={busy || !data}
            onClick={submit}
          >
            {t(`history.reset.confirm.${mode}`)}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        {preview.isPending && (
          <p className={styles.summary} role="status">
            <Spinner /> {t('history.reset.loading')}
          </p>
        )}
        {preview.error && (
          <p className={styles.lostTitle} role="alert">
            {preview.error instanceof YagguiIpcError
              ? localize(preview.error.error.message)
              : preview.error.message}
          </p>
        )}
        {data && (
          <p className={styles.summary}>
            {data.commitsLeftBehind > 0
              ? t('history.reset.behind', { branch, count: data.commitsLeftBehind })
              : data.commitsGained > 0
                ? t('history.reset.ahead', { branch, count: data.commitsGained })
                : t('history.reset.same', { branch })}
          </p>
        )}
        <ChoiceList
          label={t('history.reset.modeLabel')}
          value={mode}
          choices={choices}
          onChange={setMode}
        />
        {mode === 'hard' && data && (
          <>
            {lost.length > 0 ? (
              <>
                <p className={styles.lostTitle}>
                  {t('history.reset.lostTitle', { count: lost.length })}
                </p>
                <ul
                  className={styles.lost}
                  aria-label={t('history.reset.lostTitle', { count: lost.length })}
                >
                  {lost.map((file) => (
                    <li key={file.path}>
                      <span className={styles.lostPath}>{file.path}</span>
                      <span className={styles.lostChange}>{t(CHANGE_KEYS[file.change])}</span>
                    </li>
                  ))}
                </ul>
                <p className={styles.summary}>{t('history.reset.backupHint')}</p>
              </>
            ) : (
              <p className={styles.safe}>{t('history.reset.nothingLost')}</p>
            )}
          </>
        )}
        <code className={refStyles.command}>{`git reset --${mode} ${target.slice(0, 7)}`}</code>
      </div>
    </Dialog>
  );
}
