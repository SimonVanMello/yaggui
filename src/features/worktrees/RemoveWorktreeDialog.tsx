import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { ipc, unwrap, type YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Spinner } from '../../ui/Spinner';
import refStyles from '../refs/RefDialogs.module.css';
import { removeWorktree } from './worktreeOps';
import { useWorktreeDialogs } from './worktreeStore';
import styles from './Worktrees.module.css';

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * Confirms the removal of a linked worktree with its concrete effect (F-261, rule 9): the
 * folder goes, the branch stays, and local changes are lost only when explicitly forced.
 */
export function RemoveWorktreeDialog({ repoId, path }: { repoId: number; path: string }) {
  const t = useT();
  const close = useWorktreeDialogs((state) => state.close);
  const preview = useQuery({
    queryKey: ['worktree-remove-preview', repoId, path],
    queryFn: () => unwrap(ipc.commands.worktreeRemovePreview(repoId, path)),
    gcTime: 0,
  });
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<YagguiError | null>(null);

  const data = preview.data;
  const { staged = 0, unstaged = 0, untracked = 0, conflicted = 0 } = data?.dirty ?? {};
  const changes = staged + unstaged + untracked + conflicted;
  const dirty = changes > 0 || error?.code === 'worktreeDirty';
  const canSubmit = data !== undefined && !data.locked && (!dirty || force) && !busy;

  const run = () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    void removeWorktree(repoId, path, force).then((result) => {
      if (result.ok) close();
      else {
        setBusy(false);
        setError(result.error);
      }
    });
  };

  let effect: string;
  if (data?.missing) effect = t('worktree.remove.missing', { path });
  else if (data?.branch) effect = t('worktree.remove.branch', { path, branch: data.branch });
  else effect = t('worktree.remove.detached', { path });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('worktree.remove.title', { name: baseName(path) })}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" aria-disabled={!canSubmit} onClick={run}>
            {t('worktree.remove.confirm')}
          </Button>
        </>
      }
    >
      <div className={refStyles.form}>
        {preview.isPending ? (
          <p className={refStyles.hint}>
            <Spinner /> {t('worktree.remove.loading')}
          </p>
        ) : preview.error ? (
          <p className={refStyles.status} data-state="invalid" role="alert">
            {preview.error.message}
          </p>
        ) : (
          <p className={styles.effect}>{effect}</p>
        )}
        {data?.locked && (
          <div className={refStyles.warning} role="alert">
            <span>{t('worktree.remove.locked')}</span>
          </div>
        )}
        {dirty && !data?.locked && (
          <div className={refStyles.warning} role="alert">
            <b>{t('worktree.remove.dirtyTitle')}</b>
            <span>
              {t('worktree.remove.dirtyText', {
                count: changes,
                staged,
                unstaged: unstaged + conflicted,
                untracked,
              })}
            </span>
            <label className={refStyles.check}>
              <input
                type="checkbox"
                checked={force}
                onChange={(event) => {
                  setForce(event.target.checked);
                }}
              />
              <span>{t('worktree.remove.force')}</span>
            </label>
          </div>
        )}
        {error && error.code !== 'worktreeDirty' && (
          <p className={refStyles.status} data-state="invalid" role="alert">
            {localize(error.message)}
          </p>
        )}
        <code className={refStyles.command}>
          {`git worktree remove ${force ? '--force ' : ''}-- ${path}`}
        </code>
      </div>
    </Dialog>
  );
}
