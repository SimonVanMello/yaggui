import { useVirtualizer } from '@tanstack/react-virtual';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { useT } from '../../i18n/useT';
import type { ChangedFile } from '../../ipc';
import { Button } from '../../ui/Button';
import { ContextMenu } from '../../ui/ContextMenu';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import { IconButton } from '../../ui/IconButton';
import {
  actionTargets,
  closesOpenDiff,
  effectivePaths,
  nextAfter,
  NO_PICKS,
  pick,
  type Picked,
} from '../staging/fileSelection';
import { ChangedFileRow, type FileAction } from './ChangedFileRow';
import { preloadCodeDiffWhenIdle } from './codeDiffModule';
import { setFileLayout, useDiffStore } from './diffStore';
import { treeRows, type TreeRow } from './fileTree';
import { FolderRow } from './FolderRow';
import styles from './ChangedFileList.module.css';

const ROW_ESTIMATE = 28;

/** Which working tree list a file is dragged from. */
export type WorktreeList = 'unstaged' | 'staged';

/** Staging behaviour of a working tree list (absent for the files of a commit). */
export interface FileListStaging {
  list: WorktreeList;
  /** Stage (unstaged list) or unstage (staged list) these files. */
  onToggle: (files: ChangedFile[]) => void;
  /** Same for every file of the list. */
  onToggleAll: () => void;
  /** Discard working tree changes (unstaged list only). */
  onDiscard?: (files: ChangedFile[]) => void;
  onDiscardAll?: () => void;
  /** Files dropped from the other list. */
  onDrop: (paths: string[]) => void;
  /**
   * Right-click menu of a row. `targets` gives the files an action on it acts on; it is only
   * called when the menu renders (open), not for every visible row.
   */
  menu?: (targets: () => ChangedFile[]) => ReactNode;
}

const DRAG_TYPE = 'application/x-yaggui-files';

/** Set while a file drag is in progress: `dragover` cannot read the dragged data. */
let dragging: { list: WorktreeList; paths: string[] } | null = null;

interface ChangedFileListProps {
  /** Heading of the list, e.g. "Staged" or "Changes of a3f9c2e". */
  title: ReactNode;
  files: readonly ChangedFile[];
  selectedPath: string | null;
  onSelect: (file: ChangedFile) => void;
  /** A plain click on the file already open closes its diff (the diff view's own close). */
  onDeselect?: () => void;
  /** Line stats were skipped by the backend (huge change set). */
  statsSkipped?: boolean;
  /** Shown when `files` is empty. */
  emptyText?: string;
  /** Grows with its content (stacked lists) instead of filling and scrolling. */
  fit?: boolean;
  staging?: FileListStaging;
  /** Paths stored with Git LFS (`ChangedFiles.lfs`), badged. */
  lfsPaths?: readonly string[];
  /** Right-click menu of a file (file history, blame). */
  fileMenu?: (file: ChangedFile) => ReactNode;
  /** Hover button of a file outside the working tree lists. */
  fileAction?: (file: ChangedFile) => FileAction;
}

/**
 * Changed files of a commit or of the working tree, as a list or a folder tree, with
 * status, rename similarity and +/− stats. Virtualized; ↑/↓ moves the selection.
 * Reused by the commit details panel (M1-2).
 */
export function ChangedFileList({
  title,
  files,
  selectedPath,
  onSelect,
  onDeselect,
  statsSkipped = false,
  emptyText,
  fit = false,
  staging,
  lfsPaths,
  fileMenu,
  fileAction,
}: ChangedFileListProps) {
  const t = useT();
  const layout = useDiffStore((state) => state.fileLayout);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  // A file list on screen means a diff is likely next.
  useEffect(preloadCodeDiffWhenIdle, []);

  const rows: TreeRow[] = useMemo(
    () =>
      layout === 'tree'
        ? treeRows(files, collapsed)
        : files.map((file) => ({ kind: 'file', file, name: '', depth: 0 })),
    [files, layout, collapsed],
  );
  const totals = useMemo(
    () =>
      files.reduce(
        (sum, f) => ({ add: sum.add + (f.additions ?? 0), del: sum.del + (f.deletions ?? 0) }),
        { add: 0, del: 0 },
      ),
    [files],
  );

  const lfs = useMemo(() => new Set(lfsPaths), [lfsPaths]);
  const [picked, setPicked] = useState<Picked>(NO_PICKS);
  const [dropping, setDropping] = useState(false);
  const order = useMemo(
    () => rows.flatMap((row) => (row.kind === 'file' ? [row.file.path] : [])),
    [rows],
  );
  const selected = useMemo(
    () => effectivePaths(picked, selectedPath, new Set(files.map((f) => f.path))),
    [picked, selectedPath, files],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    getItemKey: (index) => {
      const row = rows[index];
      return row ? (row.kind === 'file' ? row.file.path : `dir:${row.path}`) : index;
    },
    overscan: 10,
  });

  const toggle = (path: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  };

  const press = (
    file: ChangedFile,
    modifiers: { shift: boolean; toggle: boolean },
    click = false,
  ) => {
    if (click && onDeselect && closesOpenDiff(file.path, modifiers, selectedPath, selected)) {
      setPicked(NO_PICKS);
      onDeselect();
      return;
    }
    if (staging && (modifiers.shift || modifiers.toggle)) {
      setPicked(
        pick(order, selected, picked.anchor ?? selectedPath, file.path, modifiers, selectedPath),
      );
      return;
    }
    setPicked({ paths: new Set([file.path]), anchor: file.path, base: file.path });
    onSelect(file);
  };

  /** Runs `act` on the files of an action started on `clicked`, then moves on to the next. */
  const actOn = (clicked: string, act: (files: ChangedFile[]) => void) => {
    const targets = actionTargets(files, selected, clicked);
    if (targets.length === 0) return;
    act(targets);
    const acted = new Set(targets.map((f) => f.path));
    const next = nextAfter(order, acted);
    const nextFile = files.find((f) => f.path === next);
    if (nextFile) {
      setPicked({ paths: new Set([nextFile.path]), anchor: nextFile.path, base: nextFile.path });
      if (selectedPath !== null && acted.has(selectedPath)) onSelect(nextFile);
    } else {
      setPicked(NO_PICKS);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (staging && event.key === ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      const first = [...selected][0];
      if (first !== undefined) actOn(first, staging.onToggle);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const head = [...selected].pop() ?? selectedPath;
    const current = rows.findIndex((r) => r.kind === 'file' && r.file.path === head);
    for (let i = current + step; i >= 0 && i < rows.length; i += step) {
      const row = rows[i];
      if (row?.kind !== 'file') continue;
      press(row.file, { shift: staging !== undefined && event.shiftKey, toggle: false });
      virtualizer.scrollToIndex(i, { align: 'auto' });
      return;
    }
  };

  const rowActions = (file: ChangedFile) => {
    if (!staging) return undefined;
    const count = actionTargets(files, selected, file.path).length;
    const staged = staging.list === 'staged';
    return {
      toggle: {
        icon: staged ? ('minus' as const) : ('plus' as const),
        label: t(staged ? 'changes.unstageFiles' : 'changes.stageFiles', { count }),
        onClick: () => {
          actOn(file.path, staging.onToggle);
        },
      },
      discard: staging.onDiscard
        ? {
            label: t('changes.discardFiles', { count }),
            onClick: () => {
              const { onDiscard } = staging;
              if (onDiscard) actOn(file.path, onDiscard);
            },
          }
        : undefined,
      onDragStart: (event: DragEvent<HTMLDivElement>) => {
        const paths = actionTargets(files, selected, file.path).map((f) => f.path);
        dragging = { list: staging.list, paths };
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
        event.dataTransfer.setData('text/plain', paths.join('\n'));
      },
      onDragEnd: () => {
        dragging = null;
      },
    };
  };

  const acceptsDrop = () =>
    staging !== undefined && dragging !== null && dragging.list !== staging.list;

  return (
    <section
      className={styles.list}
      data-fit={fit}
      data-drop={dropping}
      onDragOver={(event) => {
        if (!acceptsDrop()) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(event) => {
        setDropping(false);
        if (!staging || !acceptsDrop() || !dragging) return;
        event.preventDefault();
        const { paths } = dragging;
        dragging = null;
        staging.onDrop(paths);
      }}
    >
      <header className={styles.header}>
        <span className={styles.title}>{title}</span>
        <span className={styles.count}>{files.length}</span>
        {!statsSkipped && files.length > 0 && (
          <span className={styles.stats}>
            <span className={styles.add}>+{totals.add}</span>
            <span className={styles.del}>−{totals.del}</span>
          </span>
        )}
        <span className={styles.spacer} />
        {staging && files.length > 0 && (
          <span className={styles.headerActions}>
            {staging.onDiscardAll && (
              <IconButton
                icon="undo"
                size="sm"
                label={t('changes.discardAll')}
                onClick={staging.onDiscardAll}
              />
            )}
            <Button size="sm" variant="ghost" onClick={staging.onToggleAll}>
              {staging.list === 'staged' ? t('changes.unstageAll') : t('changes.stageAll')}
            </Button>
          </span>
        )}
        <IconButton
          icon={layout === 'tree' ? 'list' : 'tree'}
          size="sm"
          label={layout === 'tree' ? t('diff.files.asList') : t('diff.files.asTree')}
          onClick={() => {
            setFileLayout(layout === 'tree' ? 'list' : 'tree');
          }}
        />
      </header>
      {files.length === 0 ? (
        emptyText && <p className={styles.empty}>{emptyText}</p>
      ) : (
        <div
          ref={scrollRef}
          className={styles.scroll}
          role="listbox"
          aria-label={typeof title === 'string' ? title : t('diff.files.label')}
          aria-multiselectable={staging ? true : undefined}
          tabIndex={0}
          onKeyDown={onKeyDown}
          // Stacked lists keep their rows visible; a long one scrolls on its own (virtualized).
          style={
            fit ? { maxHeight: `min(${String(rows.length * ROW_ESTIMATE)}px, 45vh)` } : undefined
          }
        >
          <div
            className={styles.inner}
            style={{ height: `${String(virtualizer.getTotalSize())}px` }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              const element = (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className={styles.item}
                  style={{ transform: `translateY(${String(item.start)}px)` }}
                >
                  {row.kind === 'folder' ? (
                    <FolderRow
                      folder={row}
                      collapsed={collapsed.has(row.path)}
                      onToggle={() => {
                        toggle(row.path);
                      }}
                    />
                  ) : (
                    <ChangedFileRow
                      file={row.file}
                      name={layout === 'tree' ? row.name : null}
                      depth={row.depth}
                      selected={
                        staging ? selected.has(row.file.path) : row.file.path === selectedPath
                      }
                      onSelect={(modifiers) => {
                        press(row.file, modifiers, true);
                      }}
                      actions={rowActions(row.file)}
                      fileAction={fileAction?.(row.file)}
                      lfs={lfs.has(row.file.path)}
                    />
                  )}
                </div>
              );
              if (row.kind !== 'file' || (!staging?.menu && !fileMenu)) return element;
              const { file } = row;
              const stagingMenu = staging?.menu;
              return (
                <ContextMenu
                  key={item.key}
                  content={
                    <>
                      {stagingMenu?.(() => actionTargets(files, selected, file.path))}
                      {stagingMenu && fileMenu && <ContextMenuSeparator />}
                      {fileMenu?.(file)}
                    </>
                  }
                  onOpenChange={(open) => {
                    // A right click outside the selection acts on that file alone.
                    if (open && stagingMenu && !selected.has(file.path)) {
                      setPicked({
                        paths: new Set([file.path]),
                        anchor: file.path,
                        base: file.path,
                      });
                    }
                  }}
                >
                  {element}
                </ContextMenu>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
