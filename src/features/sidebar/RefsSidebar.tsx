import { useEffect, useMemo, useRef, useState } from 'react';

import { selectActiveTab, useTabsStore, type ShellTab } from '../../app/tabs/tabsStore';
import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useT } from '../../i18n/useT';
import { YagguiIpcError, type YagguiError } from '../../ipc';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Kbd } from '../../ui/Kbd';
import { Spinner } from '../../ui/Spinner';
import { ariaKeyShortcuts } from '../../ui/shortcuts';
import { useShortcut } from '../keybindings/registry';
import { RefTree } from './RefTree';
import styles from './RefsSidebar.module.css';
import { buildSidebarRows, type FolderRow, type SectionRow } from './sidebarRows';
import { setNodeOpen } from './sidebarUiState';
import { useRepoRefs } from './useRepoRefs';

/** Dispatched on `window` (e.g. by the palette) to focus the refs filter of the active tab. */
export const FOCUS_REFS_FILTER_EVENT = 'yaggui:focus-refs-filter';

function toYagguiError(error: Error): YagguiError {
  return error instanceof YagguiIpcError
    ? error.error
    : {
        code: 'internal',
        message: { en: error.message, fr: error.message },
        action: null,
        detail: null,
        payload: null,
      };
}

/** Left panel: branches, remotes, tags, stashes, submodules and worktrees of the repository. */
export function RefsSidebar({ tab, repoId }: { tab: ShellTab; repoId: number }) {
  const t = useT();
  const filterShortcut = useShortcut('repo.refsFilter');
  const refsQuery = useRepoRefs(repoId);
  const updateSidebar = useTabsStore((store) => store.updateSidebar);
  const setPanel = useTabsStore((store) => store.setPanel);
  const [filter, setFilter] = useState('');
  // Expanded state during a filter is temporary: clearing the filter restores the saved one.
  const [filterOpen, setFilterOpen] = useState<Record<string, boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const filtering = filter.trim() !== '';
  const refs = refsQuery.data;
  const { flat, open } = tab.sidebar;

  const tree = useMemo(
    () =>
      refs ? buildSidebarRows(refs, { open: filtering ? filterOpen : open, flat, filter }) : null,
    [refs, filtering, filterOpen, open, flat, filter],
  );
  const current = refs?.local.find((branch) => branch.isHead)?.name ?? null;

  useEffect(() => {
    const focusFilter = () => {
      if (selectActiveTab(useTabsStore.getState()).id !== tab.id) return;
      if (tab.panels.sidebar.collapsed) setPanel(tab.id, 'sidebar', { collapsed: false });
      // The collapsed panel is hidden until the next render.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    };
    // The keyboard shortcut reaches us as FOCUS_REFS_FILTER_EVENT, from the global handler (F-281).
    window.addEventListener(FOCUS_REFS_FILTER_EVENT, focusFilter);
    return () => {
      window.removeEventListener(FOCUS_REFS_FILTER_EVENT, focusFilter);
    };
  }, [tab.id, tab.panels.sidebar.collapsed, setPanel]);

  const toggle = (row: SectionRow | FolderRow) => {
    if (filtering) {
      setFilterOpen((state) => ({ ...state, [row.key]: !row.expanded }));
    } else {
      updateSidebar(tab.id, (state) => setNodeOpen(state, row.key, !row.expanded));
    }
  };

  const changeFilter = (value: string) => {
    if (value.trim() === '') setFilterOpen({});
    setFilter(value);
  };

  const focusTree = () => {
    treeRef.current?.focus();
  };

  let body: React.ReactNode;
  if (refsQuery.error) {
    body = (
      <div className={styles.state}>
        <ErrorPanel
          compact
          title={t('sidebar.loadFailed')}
          error={toYagguiError(refsQuery.error)}
          context={{ retry: () => void refsQuery.refetch() }}
        />
      </div>
    );
  } else if (!refs || !tree) {
    body = (
      <div className={styles.state} role="status">
        <Spinner />
      </div>
    );
  } else if (filtering && tree.matches === 0) {
    body = (
      <p className={styles.note} role="status">
        {t('sidebar.noMatch', { filter: filter.trim() })}
      </p>
    );
  } else {
    body = (
      <>
        {!filtering && refs.head.kind === 'unborn' && refs.local.length === 0 && (
          <p className={styles.note}>{t('sidebar.emptyRepo', { name: refs.head.name })}</p>
        )}
        <RefTree
          repoId={repoId}
          rows={tree.rows}
          graphVersion={refs.graphVersion}
          current={current}
          onToggle={toggle}
          onTypeAhead={(char) => {
            changeFilter(filter + char);
            inputRef.current?.focus();
          }}
          onEscape={() => {
            if (filtering) changeFilter('');
          }}
          treeRef={treeRef}
        />
      </>
    );
  }

  return (
    <nav className={styles.sidebar} aria-label={t('sidebar.label')}>
      <div className={styles.toolbar}>
        <label className={styles.filter}>
          <Icon name="search" />
          <input
            ref={inputRef}
            type="text"
            className={styles.input}
            value={filter}
            placeholder={t('sidebar.filter')}
            aria-label={t('sidebar.filter')}
            aria-keyshortcuts={filterShortcut ? ariaKeyShortcuts(filterShortcut) : undefined}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              changeFilter(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || (event.key === 'Enter' && filtering)) {
                event.preventDefault();
                focusTree();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                if (filtering) changeFilter('');
                else focusTree();
              }
            }}
          />
          {filtering ? (
            <span className={styles.matches} aria-live="polite">
              {tree?.matches ?? 0}
            </span>
          ) : (
            filterShortcut && <Kbd shortcut={filterShortcut} className={styles.kbd} />
          )}
        </label>
        <IconButton
          icon="log"
          size="sm"
          label={t('sidebar.flatList')}
          aria-pressed={flat}
          onClick={() => {
            updateSidebar(tab.id, (state) => ({ ...state, flat: !state.flat }));
          }}
        />
      </div>
      {body}
    </nav>
  );
}
