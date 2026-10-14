import { useState } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useT } from '../../i18n/useT';
import { YagguiIpcError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { useKnownRepos } from '../repo/useKnownRepos';
import { NameForm } from './NameForm';
import { WorkspaceOverview } from './WorkspaceOverview';
import styles from './WorkspacesDialog.module.css';
import { createWorkspace } from './workspaceOps';
import { useWorkspaces } from './workspaceQueries';
import { useWorkspaceUi } from './workspaceStore';

/** Workspaces (F-006, F-008): the list as tabs, the selected one's overview below. */
export function WorkspacesDialog() {
  const manager = useWorkspaceUi((state) => state.manager);
  return manager ? <WorkspacesManager selectedId={manager.workspaceId} /> : null;
}

function WorkspacesManager({ selectedId }: { selectedId: number | null }) {
  const t = useT();
  const workspaces = useWorkspaces();
  const known = useKnownRepos();
  const [creating, setCreating] = useState(false);
  const ui = useWorkspaceUi.getState();
  const list = workspaces.data ?? [];
  const selected = list.find((w) => w.id === selectedId) ?? list[0];

  const close = () => {
    useWorkspaceUi.getState().closeManager();
  };

  let body;
  if (workspaces.isPending || known.isPending) {
    body = (
      <div className={styles.placeholder} role="status">
        <Spinner /> {t('workspace.loading')}
      </div>
    );
  } else if (workspaces.error) {
    const error = workspaces.error;
    body = (
      <ErrorPanel
        compact
        title={t('workspace.loadFailed')}
        error={
          error instanceof YagguiIpcError
            ? error.error
            : {
                code: 'internal',
                message: { en: error.message, fr: error.message },
                action: null,
                detail: null,
                payload: null,
              }
        }
        context={{ retry: () => void workspaces.refetch() }}
      />
    );
  } else if (!selected) {
    body = creating ? null : (
      <div className={styles.empty}>
        <Icon name="box" size="lg" />
        <p className={styles.emptyTitle}>{t('workspace.none')}</p>
        <p>{t('workspace.none.description')}</p>
        <div className={styles.emptyActions}>
          <Button
            variant="primary"
            onClick={() => {
              setCreating(true);
            }}
          >
            <Icon name="plus" />
            {t('workspace.new')}
          </Button>
          <Button
            onClick={() => {
              ui.openScan(null);
            }}
          >
            <Icon name="search" />
            {t('workspace.scanFolder')}
          </Button>
        </div>
      </div>
    );
  } else {
    body = <WorkspaceOverview workspace={selected} known={known.data ?? []} onOpened={close} />;
  }

  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('workspace.title')}
      description={t('workspace.description')}
    >
      <div className={styles.bar}>
        {creating ? (
          <NameForm
            label={t('workspace.new.label')}
            submitLabel={t('workspace.new.submit')}
            onSubmit={async (name) => {
              const created = await createWorkspace(name);
              if (!created) return;
              setCreating(false);
              useWorkspaceUi.getState().selectWorkspace(created.id);
            }}
            onCancel={() => {
              setCreating(false);
            }}
          />
        ) : (
          <>
            {list.length > 0 && (
              <div role="tablist" aria-label={t('workspace.title')} className={styles.tabs}>
                {list.map((workspace) => (
                  <button
                    key={workspace.id}
                    type="button"
                    role="tab"
                    aria-selected={workspace.id === selected?.id}
                    className={styles.tab}
                    onClick={() => {
                      useWorkspaceUi.getState().selectWorkspace(workspace.id);
                    }}
                  >
                    {workspace.name}
                    <span className={styles.tabCount}>{String(workspace.repoIds.length)}</span>
                  </button>
                ))}
              </div>
            )}
            {list.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setCreating(true);
                }}
              >
                <Icon name="plus" />
                {t('workspace.new')}
              </Button>
            )}
          </>
        )}
      </div>
      {body}
      <div className={styles.footer}>
        <Button variant="ghost" onClick={close}>
          {t('common.close')}
        </Button>
      </div>
    </Dialog>
  );
}
