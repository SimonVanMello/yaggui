import { useVirtualizer } from '@tanstack/react-virtual';
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { TreeEntry, YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { ContextMenu } from '../../ui/ContextMenu';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import { Icon, type IconName } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { Spinner } from '../../ui/Spinner';
import { formatBytes } from '../diff/format';
import { closeInspect, openBlame, openFileHistory, selectTreePath } from '../inspect/inspectStore';
import { useCssPixels } from '../inspect/useCssPixels';
import { useEscapeToClose } from '../inspect/useEscapeToClose';
import { shortOid } from '../repo/repoStatus';
import { copyTreePath, saveTreeVersion } from './treeActions';
import {
  ancestorFolders,
  flattenTree,
  moveInTree,
  rowKey,
  type TreeKey,
  type TreeRow,
} from './treeModel';
import { useTreeListings } from './treeQueries';
import { TreeFileView } from './TreeFileView';
import common from '../inspect/Inspect.module.css';
import styles from './TreeView.module.css';

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;
const NAVIGATION_KEYS: ReadonlySet<string> = new Set([
  'ArrowDown',
  'ArrowUp',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
]);
/** The file pane follows the selection after this delay: arrowing through files stays light. */
const FILE_DELAY_MS = 120;

function iconOf(entry: TreeEntry, expanded: boolean): IconName {
  switch (entry.kind) {
    case 'dir':
      return expanded ? 'folderOpen' : 'folder';
    case 'symlink':
      return 'external';
    case 'submodule':
      return 'box';
    default:
      return IMAGE.test(entry.name) ? 'image' : 'file';
  }
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);
  return debounced;
}

interface RowProps {
  row: TreeRow;
  index: number;
  top: number;
  active: boolean;
  sizeLabel: string;
  failed: YagguiError | undefined;
  loadingLabel: string;
  emptyLabel: string;
  failedLabel: string;
}

/** One row. Memoized: events are delegated to the tree, so a render only follows its data. */
const Row = memo(function Row({
  row,
  index,
  top,
  active,
  sizeLabel,
  failed,
  loadingLabel,
  emptyLabel,
  failedLabel,
}: RowProps) {
  const inset = { paddingInlineStart: `calc(${String(row.depth)} * var(--tree-indent))` };
  const position = { transform: `translateY(${String(top)}px)` };
  if (row.kind !== 'entry') {
    return (
      <div
        role="none"
        className={styles.note}
        data-index={index}
        style={{ ...position, ...inset }}
        aria-live="polite"
      >
        {row.kind === 'empty' ? (
          emptyLabel
        ) : failed ? (
          <span className={styles.failed}>{failedLabel}</span>
        ) : (
          <>
            <Spinner />
            {loadingLabel}
          </>
        )}
      </div>
    );
  }
  const { entry } = row;
  const dir = entry.kind === 'dir';
  return (
    <div
      role="treeitem"
      id={`tree-row-${String(index)}`}
      className={styles.row}
      aria-level={row.depth + 1}
      aria-expanded={dir ? row.expanded : undefined}
      aria-selected={active}
      data-path={row.path}
      data-active={active}
      data-kind={entry.kind}
      style={{ ...position, ...inset }}
    >
      <span className={styles.chevron} aria-hidden="true">
        {dir && <Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} size="sm" />}
      </span>
      <Icon name={iconOf(entry, row.expanded)} size="sm" className={styles.icon} />
      <span className={styles.name} title={entry.name}>
        {entry.name}
      </span>
      {sizeLabel && <span className={styles.size}>{sizeLabel}</span>}
    </div>
  );
});

function pathOf(target: EventTarget): string | null {
  const row = target instanceof Element ? target.closest<HTMLElement>('[data-path]') : null;
  return row?.dataset['path'] ?? null;
}

/**
 * The tree of a commit (F-224): folders load as they are opened, the file selected is read
 * as it was in that commit. Keyboard: arrows move, right / left open and close folders.
 */
export function TreeView({
  repoId,
  rev,
  path,
}: {
  repoId: number;
  rev: string;
  /** The file or folder shown, from the inspect store. */
  path: string | null;
}) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(path === null ? [] : ancestorFolders(path)),
  );
  const { sha, listings, errors } = useTreeListings(repoId, rev, open);
  const rows = useMemo(() => flattenTree(listings, open), [listings, open]);
  const indexOf = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, i) => {
      if (row.kind === 'entry') map.set(row.path, i);
    });
    return map;
  }, [rows]);
  const activeIndex = path === null ? undefined : indexOf.get(path);
  const activeRow = activeIndex === undefined ? undefined : rows[activeIndex];
  const activeEntry = activeRow?.kind === 'entry' ? activeRow : undefined;
  const filePath = useDebounced(
    activeEntry && activeEntry.entry.kind !== 'dir' ? activeEntry.path : null,
    FILE_DELAY_MS,
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = useCssPixels('--row-height', 28);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    getItemKey: (index) => {
      const row = rows[index];
      return row ? rowKey(row) : index;
    },
    overscan: 12,
  });

  // The file the view was opened on comes into view once its folders are loaded.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (path === null || activeIndex === undefined || revealed.current === path) return;
    revealed.current = path;
    virtualizer.scrollToIndex(activeIndex, { align: 'center' });
  }, [path, activeIndex, virtualizer]);

  const close = () => {
    closeInspect(repoId);
  };
  useEscapeToClose(close);

  const toggle = (folder: string, next: boolean) => {
    setOpen((current) => {
      const copy = new Set(current);
      if (next) copy.add(folder);
      else copy.delete(folder);
      return copy;
    });
  };
  const select = (target: string) => {
    selectTreePath(repoId, target);
  };
  // A path to show that may sit in a closed folder (a symbolic link's target).
  const goTo = (target: string) => {
    setOpen((current) => new Set([...current, ...ancestorFolders(target)]));
    revealed.current = null;
    select(target);
  };
  const exists = (target: string) => {
    const slash = target.lastIndexOf('/');
    const folder = slash < 0 ? '' : target.slice(0, slash);
    const name = target.slice(slash + 1);
    return listings.get(folder)?.entries.some((entry) => entry.name === name) ?? false;
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = pathOf(event.target);
    const index = target === null ? undefined : indexOf.get(target);
    const row = index === undefined ? undefined : rows[index];
    if (target === null || row?.kind !== 'entry') return;
    select(target);
    if (row.entry.kind === 'dir') toggle(target, !row.expanded);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (NAVIGATION_KEYS.has(event.key)) {
      event.preventDefault();
      const move = moveInTree(rows, path, event.key as TreeKey);
      if (!move) return;
      if (move.toggle) toggle(move.toggle.path, move.toggle.open);
      select(move.active);
      const index = indexOf.get(move.active);
      if (index !== undefined) virtualizer.scrollToIndex(index, { align: 'auto' });
    } else if ((event.key === 'Enter' || event.key === ' ') && activeEntry) {
      if (activeEntry.entry.kind !== 'dir') return;
      event.preventDefault();
      toggle(activeEntry.path, !activeEntry.expanded);
    }
  };

  const [menuPath, setMenuPath] = useState<string | null>(null);
  const menuIndex = menuPath === null ? undefined : indexOf.get(menuPath);
  const menuRow = menuIndex === undefined ? undefined : rows[menuIndex];
  const menuEntry = menuRow?.kind === 'entry' ? menuRow : undefined;
  const menuFile = menuEntry && menuEntry.entry.kind !== 'dir' ? menuEntry : undefined;

  const rootError = errors.get('');
  const rootLoading = rows.length === 1 && rows[0]?.kind === 'loading';
  let body;
  if (rootError) {
    body = (
      <div className={common.centered}>
        <ErrorPanel title={t('tree.failed')} error={rootError} />
      </div>
    );
  } else {
    body = (
      <div className={styles.layout}>
        <ContextMenu
          content={
            menuEntry && (
              <>
                {menuFile && sha && (
                  <>
                    <ContextMenuItem
                      icon="history"
                      onSelect={() => {
                        openFileHistory(repoId, menuFile.path, sha);
                      }}
                    >
                      {t('inspect.action.history')}
                    </ContextMenuItem>
                    <ContextMenuItem
                      icon="blame"
                      disabled={
                        menuFile.entry.kind === 'symlink' || menuFile.entry.kind === 'submodule'
                      }
                      onSelect={() => {
                        openBlame(repoId, menuFile.path, sha);
                      }}
                    >
                      {t('inspect.action.blameAt')}
                    </ContextMenuItem>
                    <ContextMenuItem
                      icon="pop"
                      disabled={menuFile.entry.kind === 'submodule'}
                      onSelect={() => {
                        void saveTreeVersion(repoId, sha, menuFile.path);
                      }}
                    >
                      {t('tree.action.save')}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                  </>
                )}
                <ContextMenuItem
                  icon="copy"
                  onSelect={() => {
                    copyTreePath(menuEntry.path);
                  }}
                >
                  {t('tree.action.copyPath')}
                </ContextMenuItem>
              </>
            )
          }
        >
          <div
            ref={scrollRef}
            className={styles.tree}
            role="tree"
            tabIndex={0}
            aria-label={t('tree.nav')}
            aria-activedescendant={
              activeIndex === undefined ? undefined : `tree-row-${String(activeIndex)}`
            }
            onClick={onClick}
            onKeyDown={onKeyDown}
            onContextMenu={(event) => {
              const target = pathOf(event.target);
              setMenuPath(target);
              if (target !== null) select(target);
            }}
          >
            <div
              className={styles.inner}
              style={{ height: `${String(virtualizer.getTotalSize())}px` }}
            >
              {rootLoading && (
                <div className={styles.note} role="status">
                  <Spinner />
                  {t('tree.loading')}
                </div>
              )}
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index];
                if (!row || (rootLoading && row.kind === 'loading')) return null;
                return (
                  <Row
                    key={item.key}
                    row={row}
                    index={item.index}
                    top={item.start}
                    active={row.kind === 'entry' && row.path === path}
                    sizeLabel={
                      row.kind === 'entry' && row.entry.size !== null
                        ? formatBytes(row.entry.size, locale)
                        : ''
                    }
                    failed={row.kind === 'loading' ? errors.get(row.path) : undefined}
                    loadingLabel={t('tree.rowLoading')}
                    emptyLabel={t('tree.folderEmpty')}
                    failedLabel={t('tree.folderFailed')}
                  />
                );
              })}
            </div>
          </div>
        </ContextMenu>
        {filePath !== null && sha !== null ? (
          <TreeFileView
            key={sha}
            repoId={repoId}
            sha={sha}
            path={filePath}
            onGoTo={goTo}
            exists={exists}
          />
        ) : (
          <div className={common.centered}>
            <Icon name="tree" size="lg" />
            <span>{t('tree.selectFile')}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <section className={common.view} aria-label={t('tree.label', { sha: shortOid(sha ?? rev) })}>
      <header className={common.toolbar}>
        <Button size="sm" variant="ghost" onClick={close}>
          <Icon name="back" />
          {t('diff.back')}
          <Kbd shortcut="Escape" />
        </Button>
        <span className={common.title}>
          <Icon name="tree" className={common.titleIcon} />
          {t('tree.title')}
        </span>
        <span className={common.chip} title={sha ?? rev}>
          {sha ? shortOid(sha) : rev}
        </span>
        {rootLoading && <Spinner />}
      </header>
      {body}
    </section>
  );
}
