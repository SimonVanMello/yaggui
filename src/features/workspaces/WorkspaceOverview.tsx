import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, useState } from 'react';

import { queryClient } from '../../app/queryClient';
import { useT } from '../../i18n/useT';
import type { KnownRepo, Workspace } from '../../ipc';
import { useYagguiEvent } from '../../ipc/useYagguiEvent';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { useNow } from '../../ui/useNow';
import { openRepoPath } from '../repo/repoSessions';
import { AddReposPanel } from './AddReposPanel';
import { NameForm } from './NameForm';
import { OverviewRow } from './OverviewRow';
import styles from './WorkspaceOverview.module.css';
import {
  addReposToWorkspace,
  deleteWorkspace,
  fetchWorkspace,
  openWorkspace,
  removeRepoFromWorkspace,
  renameWorkspace,
} from './workspaceOps';
import { workspaceKeys } from './workspaceQueries';
import { useWorkspaceUi } from './workspaceStore';

/** Measured rows: the estimate only matters for the first paint. */
const ROW_ESTIMATE = 46;

interface WorkspaceOverviewProps {
  workspace: Workspace;
  known: readonly KnownRepo[];
  onOpened: () => void;
}

/** Overview of a workspace (F-008): its repos with their state, open all, fetch all. */
export function WorkspaceOverview({ workspace, known, onOpened }: WorkspaceOverviewProps) {
  const t = useT();
  const now = useNow();
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const byId = new Map(known.map((repo) => [repo.id, repo]));
  const repos = workspace.repoIds.flatMap((id) => byId.get(id) ?? []);
  const others = known.filter((repo) => !workspace.repoIds.includes(repo.id));
  const fetching = useWorkspaceUi((state) =>
    workspace.repoIds.some((id) => state.fetches[id]?.status === 'running'),
  );
  const showMissing = useWorkspaceUi((state) => state.showMissing);

  // Rows of open repos follow the watcher; other repos are read again when the dialog reopens.
  const refresh = ({ repoId }: { repoId: number }) => {
    if (workspace.repoIds.includes(repoId)) {
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.overview(repoId) });
    }
  };
  useYagguiEvent('statusChanged', refresh);
  useYagguiEvent('refsChanged', refresh);

  const virtualizer = useVirtualizer({
    count: repos.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    getItemKey: (index) => repos[index]?.id ?? index,
    overscan: 6,
  });

  const header = renaming ? (
    <NameForm
      initial={workspace.name}
      label={t('workspace.rename.label')}
      submitLabel={t('workspace.rename.submit')}
      onSubmit={async (name) => {
        const done = await renameWorkspace(workspace.id, name);
        if (done) setRenaming(false);
      }}
      onCancel={() => {
        setRenaming(false);
      }}
    />
  ) : (
    <div className={styles.title}>
      <h3 className={styles.name}>{workspace.name}</h3>
      <span className={styles.count}>
        {t('workspace.repoCount', { count: workspace.repoIds.length })}
      </span>
      <IconButton
        size="sm"
        icon="settings"
        label={t('workspace.rename')}
        onClick={() => {
          setRenaming(true);
        }}
      />
      <IconButton
        size="sm"
        icon="trash"
        label={t('workspace.delete')}
        onClick={() => {
          void deleteWorkspace(workspace);
        }}
      />
    </div>
  );

  return (
    <section className={styles.overview} aria-label={workspace.name}>
      <div className={styles.header}>
        {header}
        <div className={styles.actions}>
          <Button
            size="sm"
            aria-expanded={adding}
            onClick={() => {
              setAdding((open) => !open);
            }}
          >
            <Icon name="plus" />
            {t('workspace.addRepos')}
          </Button>
          <Button
            size="sm"
            disabled={repos.length === 0 || fetching}
            onClick={() => {
              void fetchWorkspace(workspace);
            }}
          >
            <Icon name="fetch" />
            {t('workspace.fetchAll')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={repos.length === 0}
            onClick={() => {
              onOpened();
              void openWorkspace(workspace);
            }}
          >
            <Icon name="folderOpen" />
            {t('workspace.openAll')}
          </Button>
        </div>
      </div>

      {adding && (
        <AddReposPanel
          candidates={others}
          onAdd={(repoId) => {
            void addReposToWorkspace(workspace.id, [repoId]);
          }}
          onScan={() => {
            useWorkspaceUi.getState().openScan(workspace.id);
          }}
          onClose={() => {
            setAdding(false);
          }}
        />
      )}

      {repos.length === 0 ? (
        <div className={styles.empty}>
          <Icon name="box" size="lg" />
          <p>{t('workspace.overview.empty')}</p>
        </div>
      ) : (
        <>
          <div className={styles.columns} aria-hidden="true">
            <span>{t('workspace.overview.repo')}</span>
            <span>{t('workspace.overview.branch')}</span>
            <span>{t('workspace.overview.syncColumn')}</span>
            <span>{t('workspace.overview.changesColumn')}</span>
            <span>{t('workspace.overview.fetchColumn')}</span>
            <span />
          </div>
          <div ref={scrollRef} className={styles.scroll}>
            <div
              role="list"
              aria-label={t('workspace.overview.list', { name: workspace.name })}
              className={styles.list}
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualizer.getVirtualItems().map((item) => {
                const repo = repos[item.index];
                if (!repo) return null;
                return (
                  <div
                    key={item.key}
                    ref={virtualizer.measureElement}
                    data-index={item.index}
                    className={styles.item}
                    style={{ transform: `translateY(${String(item.start)}px)` }}
                  >
                    <OverviewRow
                      repo={repo}
                      now={now}
                      onOpen={() => {
                        onOpened();
                        void openRepoPath(repo.path);
                      }}
                      onRemove={() => {
                        void removeRepoFromWorkspace(workspace.id, repo.id);
                      }}
                      onLocate={() => {
                        showMissing(repo.id, workspace.id);
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
