import { useState } from 'react';

import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { useKnownRepos } from '../repo/useKnownRepos';
import styles from './MissingRepoDialog.module.css';
import { forgetRepo, relocateRepo, removeRepoFromWorkspace } from './workspaceOps';
import { useWorkspaces } from './workspaceQueries';
import { useWorkspaceUi } from './workspaceStore';

/** A repo whose folder moved or disappeared (F-009): locate it again, or remove it. */
export function MissingRepoDialog() {
  const missing = useWorkspaceUi((state) => state.missing);
  return missing ? <MissingRepo repoId={missing.repoId} workspaceId={missing.workspaceId} /> : null;
}

function MissingRepo({ repoId, workspaceId }: { repoId: number; workspaceId: number | null }) {
  const t = useT();
  const repo = useKnownRepos().data?.find((candidate) => candidate.id === repoId);
  const workspace = useWorkspaces().data?.find((candidate) => candidate.id === workspaceId);
  const [busy, setBusy] = useState(false);

  const close = () => {
    useWorkspaceUi.getState().closeMissing();
  };
  const run = async (work: () => Promise<boolean>) => {
    setBusy(true);
    try {
      if (await work()) close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('workspace.missing.title', { name: repo?.name ?? '' })}
      description={t('workspace.missing.description')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              void run(() => relocateRepo(repoId));
            }}
          >
            <Icon name="folderOpen" />
            {t('workspace.missing.locate')}
          </Button>
        </>
      }
    >
      {repo && <div className={styles.path}>{repo.path}</div>}
      <div className={styles.remove}>
        {workspace && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              void run(async () => {
                await removeRepoFromWorkspace(workspace.id, repoId);
                return true;
              });
            }}
          >
            {t('workspace.missing.removeFrom', { name: workspace.name })}
          </Button>
        )}
        <Button
          size="sm"
          variant="danger"
          disabled={busy}
          onClick={() => {
            void run(async () => {
              await forgetRepo(repoId);
              return true;
            });
          }}
        >
          {t('workspace.missing.forget')}
        </Button>
      </div>
      <p className={styles.note}>{t('workspace.missing.note')}</p>
    </Dialog>
  );
}
