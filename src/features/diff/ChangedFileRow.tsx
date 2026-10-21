import type { DragEvent } from 'react';

import { useT } from '../../i18n/useT';
import type { ChangedFile } from '../../ipc';
import type { IconName } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { splitPath } from './fileTree';
import { STATUS_LETTER } from './format';
import styles from './ChangedFileList.module.css';

/** Buttons shown on hover (and on the selected / focused row) of a working tree file. */
export interface RowActions {
  toggle: { icon: 'plus' | 'minus'; label: string; onClick: () => void };
  discard?: { label: string; onClick: () => void };
  /** The row can be dragged to the other list. */
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}

/** A button of its own on a file row outside the working tree lists (apply a stashed file). */
export interface FileAction {
  icon: IconName;
  label: string;
  onClick: () => void;
}

export interface PressModifiers {
  shift: boolean;
  toggle: boolean;
}

interface ChangedFileRowProps {
  file: ChangedFile;
  /** Tree rows show only the name (the folder is the parent row). */
  name: string | null;
  depth: number;
  selected: boolean;
  onSelect: (modifiers: PressModifiers) => void;
  actions?: RowActions;
  fileAction?: FileAction;
  /** Stored with Git LFS (F-262). */
  lfs?: boolean;
}

export function ChangedFileRow({
  file,
  name,
  depth,
  selected,
  onSelect,
  actions,
  fileAction,
  lfs = false,
}: ChangedFileRowProps) {
  const t = useT();
  const { dir, name: base } = splitPath(file.path);
  const moved = file.oldPath !== null && file.oldPath !== file.path;
  const modeChanged = file.oldMode && file.newMode && file.oldMode !== file.newMode;
  return (
    <div
      role="option"
      aria-selected={selected}
      className={styles.row}
      data-status={file.status}
      style={{ paddingInlineStart: `calc(var(--space-4) + ${String(depth)} * var(--space-5))` }}
      draggable={actions ? true : undefined}
      onDragStart={actions?.onDragStart}
      onDragEnd={actions?.onDragEnd}
      onClick={(event) => {
        onSelect({ shift: event.shiftKey, toggle: event.metaKey || event.ctrlKey });
      }}
      title={moved ? `${file.oldPath ?? ''} → ${file.path}` : file.path}
    >
      <span className={styles.status} aria-label={t(`diff.status.${file.status}`)}>
        {STATUS_LETTER[file.status]}
      </span>
      <span className={styles.name}>
        <span className={styles.base}>{name ?? base}</span>
        {name === null && dir && <span className={styles.dir}>{dir.slice(0, -1)}</span>}
        {moved && (
          <span className={styles.dir}>{t('diff.from', { path: file.oldPath ?? '' })}</span>
        )}
      </span>
      {file.similarity !== null && moved && (
        <span className={styles.chip}>{t('diff.similarity', { similarity: file.similarity })}</span>
      )}
      {modeChanged && <span className={styles.chip}>{t('diff.modeChip')}</span>}
      {file.binary && <span className={styles.chip}>{t('diff.binaryChip')}</span>}
      {(file.oldMode === 'submodule' || file.newMode === 'submodule') && !modeChanged && (
        <span className={styles.chip}>{t('diff.submoduleChip')}</span>
      )}
      {lfs && (
        <span className={styles.chip} title={t('lfs.chipTitle')} data-chip="lfs">
          {t('lfs.chip')}
        </span>
      )}
      {file.additions !== null && (
        <span className={styles.stats}>
          {file.additions > 0 && <span className={styles.add}>+{file.additions}</span>}
          {(file.deletions ?? 0) > 0 && <span className={styles.del}>−{file.deletions}</span>}
        </span>
      )}
      {fileAction && !actions && (
        <span className={styles.actions}>
          <IconButton
            icon={fileAction.icon}
            size="sm"
            label={fileAction.label}
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation();
              fileAction.onClick();
            }}
          />
        </span>
      )}
      {actions && (
        <span className={styles.actions}>
          {actions.discard && (
            <IconButton
              icon="undo"
              size="sm"
              label={actions.discard.label}
              tabIndex={-1}
              onClick={(event) => {
                event.stopPropagation();
                actions.discard?.onClick();
              }}
            />
          )}
          <IconButton
            icon={actions.toggle.icon}
            size="sm"
            label={actions.toggle.label}
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation();
              actions.toggle.onClick();
            }}
          />
        </span>
      )}
    </div>
  );
}
