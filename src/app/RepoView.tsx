import { lazy, Suspense, useEffect, useRef, useState } from 'react';

import { ComparePanel } from '../features/compare/ComparePanel';
import { useCompare } from '../features/compare/compareStore';
import { ConflictsPanel } from '../features/conflicts/ConflictsPanel';
import { ConflictView } from '../features/conflicts/ConflictView';
import { closeConflictView, useConflictView } from '../features/conflicts/conflictViewStore';
import { DiffView } from '../features/diff/DiffView';
import { closeDiff, openDiff, useDiffSelection } from '../features/diff/diffStore';
import { CommitDetailPanel } from '../features/graph/CommitDetailPanel';
import { GraphView } from '../features/graph/GraphView';
import { useGraphSource } from '../features/graph/graphSource';
import { FileInspectButtons } from '../features/inspect/FileInspectButtons';
import { InspectView } from '../features/inspect/InspectView';
import { useInspectView } from '../features/inspect/inspectStore';
import { InteractiveRebaseView } from '../features/rebase/InteractiveRebaseView';
import { useInteractiveRebase } from '../features/rebase/rebaseStore';
import { StashPreviewPanel } from '../features/refs/StashPreviewPanel';
import { useStashPreview } from '../features/refs/stashPreview';
import { useRepoRefs } from '../features/sidebar/useRepoRefs';
import { useSelectedSha } from '../features/repo/graphNavigation';
import { useAutoFetch } from '../features/network/useAutoFetch';
import { RepoBanners } from '../features/repo/RepoBanners';
import {
  restoreRepoSession,
  closeTabAndRepo,
  useRepoSessions,
} from '../features/repo/repoSessions';
import { useKnownRepos } from '../features/repo/useKnownRepos';
import { useRepoState } from '../features/repo/useRepoState';
import { RefsSidebar } from '../features/sidebar/RefsSidebar';
import { ChangesPanel } from '../features/staging/ChangesPanel';
import { useRepoTerminals } from '../features/terminal/terminalStore';
import { Toolbar } from '../features/toolbar/Toolbar';
import { useT } from '../i18n/useT';
import { YagguiIpcError, type RepoInfo } from '../ipc';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Spinner } from '../ui/Spinner';
import { forgetKnownRepo } from '../features/repo/knownRepoActions';
import { relocateRepo } from '../features/workspaces/workspaceOps';
import { ErrorPanel } from './errors/ErrorPanel';
import { CENTER_MIN_WIDTH, fitPanels } from './layout/panels';
import { PanelResizer } from './layout/PanelResizer';
import styles from './RepoView.module.css';
import type { ShellTab } from './tabs/tabsStore';

/** The emulator (xterm) is only loaded once a terminal is opened. */
const TerminalPanel = lazy(() => import('../features/terminal/TerminalPanel'));

/** Width of the repo view, to keep the center at its minimum while resizing side panels. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, width] as const;
}

function OpenRepoLayout({ tab, repo }: { tab: ShellTab; repo: RepoInfo }) {
  const t = useT();
  const query = useRepoState(repo.id);
  const [ref, width] = useWidth();
  const state = query.data ?? repo.state;
  const source = useGraphSource(repo.id);
  const selection = source.selection;
  const diff = useDiffSelection(tab.id);
  const rebase = useInteractiveRebase(repo.id);
  const conflictView = useConflictView(tab.id);
  const inspect = useInspectView(repo.id);
  const { sidebar, details } = tab.panels;
  const selectedSha = useSelectedSha(repo.id);
  const stashSelected = useStashPreview((store) => store.preview[repo.id]);
  const clearStashPreview = useStashPreview((store) => store.clear);
  const refs = useRepoRefs(repo.id).data;
  const compare = useCompare(repo.id);
  const terminalOpen = useRepoTerminals(repo.id).open;
  useAutoFetch(repo.id);
  // The preview follows the stash that is still in the list (a pop or drop elsewhere ends it).
  const stash = stashSelected ? refs?.stashes.find((s) => s.sha === stashSelected.sha) : undefined;
  // Selecting any other commit leaves the stash preview.
  const previewed = stash && selectedSha === stash.baseSha ? stash : null;
  useEffect(() => {
    if (!stashSelected) return;
    if (selectedSha !== stashSelected.baseSha || (refs !== undefined && !stash)) {
      clearStashPreview(repo.id);
    }
  }, [stashSelected, stash, refs, selectedSha, clearStashPreview, repo.id]);
  const { sidebar: sidebarWidth, details: detailsWidth } = fitPanels(tab.panels, width);

  return (
    <div className={styles.repo}>
      <Toolbar tab={tab} repo={repo} state={state} />
      {query.error && (
        <div className={styles.stateError}>
          <ErrorPanel
            compact
            title={t('repo.stateFailed')}
            error={
              query.error instanceof YagguiIpcError
                ? query.error.error
                : {
                    code: 'internal',
                    message: { en: query.error.message, fr: query.error.message },
                    action: null,
                    detail: null,
                    payload: null,
                  }
            }
            context={{ retry: () => void query.refetch() }}
          />
        </div>
      )}
      <div
        ref={ref}
        className={styles.panels}
        style={{
          gridTemplateColumns: `${String(sidebarWidth)}px auto minmax(0, 1fr) auto ${String(detailsWidth)}px`,
        }}
      >
        <div className={styles.side} hidden={sidebar.collapsed}>
          <RefsSidebar tab={tab} repoId={repo.id} />
        </div>
        <PanelResizer
          tabId={tab.id}
          panel="sidebar"
          state={sidebar}
          side="left"
          maxSize={width - detailsWidth - CENTER_MIN_WIDTH}
        />
        <main className={styles.center} aria-label={t('graph.label')}>
          <RepoBanners
            repoId={repo.id}
            state={state}
            watchError={repo.watchError}
            onRefresh={() => void query.refetch()}
          />
          {/* A conflict or a selected file's diff replaces the graph (spec §4); Esc goes back. The
              file history, blame, reflog (M4-4) and interactive rebase (F-142) replace it too; a
              conflict or diff opened meanwhile shows over them. */}
          {conflictView?.repoId === repo.id &&
          (state.operation !== null || state.dirty.conflicted > 0) ? (
            <ConflictView
              key={conflictView.path}
              tabId={tab.id}
              repoId={repo.id}
              path={conflictView.path}
              operation={state.operation}
              onClose={() => {
                closeConflictView(tab.id);
              }}
            />
          ) : diff?.repoId === repo.id ? (
            <DiffView
              selection={diff}
              onClose={() => {
                closeDiff(tab.id);
              }}
              onSelect={(next) => {
                openDiff(tab.id, next);
              }}
              actions={
                <FileInspectButtons
                  repoId={repo.id}
                  path={diff.path}
                  rev={diff.target.kind === 'commits' ? diff.target.to : null}
                />
              }
            />
          ) : inspect ? (
            <InspectView repoId={repo.id} view={inspect} />
          ) : rebase ? (
            <InteractiveRebaseView tabId={tab.id} repoId={repo.id} session={rebase} />
          ) : (
            <GraphView tab={tab} repoId={repo.id} state={state} />
          )}
        </main>
        <PanelResizer
          tabId={tab.id}
          panel="details"
          state={details}
          side="right"
          maxSize={width - sidebarWidth - CENTER_MIN_WIDTH}
        />
        <div className={styles.side} hidden={details.collapsed}>
          {compare ? (
            <ComparePanel repoId={repo.id} tabId={tab.id} request={compare} />
          ) : previewed ? (
            <StashPreviewPanel repoId={repo.id} tabId={tab.id} stash={previewed} />
          ) : selection?.kind === 'commit' ? (
            <CommitDetailPanel
              source={source}
              sha={selection.sha}
              repoId={repo.id}
              tabId={tab.id}
            />
          ) : (
            <div className={styles.stack}>
              {state.operation !== null || state.dirty.conflicted > 0 ? (
                <ConflictsPanel repoId={repo.id} tabId={tab.id} />
              ) : null}
              <div className={styles.stackMain}>
                <ChangesPanel state={state} repoId={repo.id} tabId={tab.id} />
              </div>
            </div>
          )}
        </div>
      </div>
      {terminalOpen && (
        <Suspense fallback={null}>
          <TerminalPanel repoId={repo.id} />
        </Suspense>
      )}
    </div>
  );
}

/** Content of a repository tab: loading, open layout, or why it could not be opened. */
export function RepoView({ tab, repoId }: { tab: ShellTab; repoId: number }) {
  const t = useT();
  const session = useRepoSessions((state) => state.sessions[repoId]);
  const known = useKnownRepos().data?.find((repo) => repo.id === repoId);

  if (session?.status === 'open') return <OpenRepoLayout tab={tab} repo={session.info} />;

  if (session?.status === 'error') {
    const name = session.name ?? known?.name;
    return (
      <div className={styles.centered}>
        <ErrorPanel
          title={name ? t('repo.openFailedNamed', { name }) : t('repo.openFailed')}
          error={session.error}
          context={{ retry: () => void restoreRepoSession(repoId) }}
        >
          {session.error.action?.kind !== 'retry' && (
            <Button
              onClick={() => {
                void restoreRepoSession(repoId);
              }}
            >
              <Icon name="retry" />
              {t('error.action.retry')}
            </Button>
          )}
          {known && !known.exists && (
            <Button
              onClick={() => {
                void relocateRepo(repoId);
              }}
            >
              <Icon name="folderOpen" />
              {t('workspace.missing.locate')}
            </Button>
          )}
          {known && !known.exists && (
            <Button
              variant="ghost"
              onClick={() => {
                void forgetKnownRepo(repoId);
                closeTabAndRepo(tab.id);
              }}
            >
              {t('repo.forgetAndClose')}
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              closeTabAndRepo(tab.id);
            }}
          >
            {t('tab.menu.close')}
          </Button>
        </ErrorPanel>
      </div>
    );
  }

  return (
    <div className={styles.centered} role="status">
      <Spinner />
      <span className={styles.loading}>
        {t('repo.opening', { name: known?.name ?? session?.name ?? '' })}
      </span>
    </div>
  );
}
