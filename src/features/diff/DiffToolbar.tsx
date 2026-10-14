import type { ReactNode } from 'react';

import { useT } from '../../i18n/useT';
import type { ChangedFile, DiffViewMode } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Kbd } from '../../ui/Kbd';
import { Menu } from '../../ui/Menu';
import { MenuCheckboxItem } from '../../ui/MenuCheckboxItem';
import { MenuRadioGroup } from '../../ui/MenuRadioGroup';
import { MenuRadioItem } from '../../ui/MenuRadioItem';
import { MenuSeparator } from '../../ui/MenuSeparator';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { CONTEXT_CHOICES, setDiffOptions, setDiffView, useDiffOptions } from './diffStore';
import { splitPath } from './fileTree';
import { STATUS_LETTER } from './format';
import styles from './DiffToolbar.module.css';

interface DiffToolbarProps {
  path: string;
  oldPath: string | null;
  file: ChangedFile | undefined;
  view: DiffViewMode;
  /** Position in the file list, for "3 / 12". */
  position: { index: number; total: number } | null;
  onBack: () => void;
  onFile: (direction: 1 | -1) => void;
  canPrevious: boolean;
  canNext: boolean;
  /** Labels of the previous / next buttons when they step through something else than files. */
  stepLabels?: { previous: string; next: string };
  /** Extra buttons (file history, blame), before the layout controls. */
  actions?: ReactNode;
}

function PathLabel({ path }: { path: string }) {
  const { dir, name } = splitPath(path);
  return (
    <span className={styles.path} title={path}>
      <span className={styles.dir}>{dir}</span>
      {name}
    </span>
  );
}

/** Header of the diff: back to the graph, file, stats, navigation, layout and options. */
export function DiffToolbar({
  path,
  oldPath,
  file,
  view,
  position,
  onBack,
  onFile,
  canPrevious,
  canNext,
  stepLabels,
  actions,
}: DiffToolbarProps) {
  const t = useT();
  const options = useDiffOptions();

  return (
    <div className={styles.toolbar}>
      <Button size="sm" variant="ghost" className={styles.back} onClick={onBack}>
        <Icon name="back" />
        {t('diff.back')}
        <Kbd shortcut="Escape" />
      </Button>
      {file && (
        <span
          className={styles.status}
          data-status={file.status}
          aria-label={t(`diff.status.${file.status}`)}
        >
          {STATUS_LETTER[file.status]}
        </span>
      )}
      <span className={styles.file}>
        {oldPath && oldPath !== path && (
          <>
            <PathLabel path={oldPath} />
            <span className={styles.arrow} aria-label={t('diff.renamedTo')}>
              →
            </span>
          </>
        )}
        <PathLabel path={path} />
      </span>
      {file?.additions != null && (
        <span className={styles.stats}>
          <span className={styles.add}>+{file.additions}</span>
          <span className={styles.del}>−{file.deletions ?? 0}</span>
        </span>
      )}
      <span className={styles.spacer} />
      {position && (
        <span className={styles.position}>
          {t('diff.position', { index: position.index + 1, total: position.total })}
        </span>
      )}
      <IconButton
        icon="chevronUp"
        size="sm"
        label={stepLabels?.previous ?? t('diff.previousFile')}
        shortcut="K"
        disabled={!canPrevious}
        onClick={() => {
          onFile(-1);
        }}
      />
      <IconButton
        icon="chevronDown"
        size="sm"
        label={stepLabels?.next ?? t('diff.nextFile')}
        shortcut="J"
        disabled={!canNext}
        onClick={() => {
          onFile(1);
        }}
      />
      {actions}
      <SegmentedControl
        label={t('diff.layout')}
        value={view}
        options={[
          { value: 'unified', label: t('diff.unified') },
          { value: 'split', label: t('diff.split') },
        ]}
        onChange={setDiffView}
      />
      <Menu
        align="end"
        trigger={<IconButton icon="settings" size="sm" label={t('diff.options')} />}
      >
        <MenuCheckboxItem
          checked={options.wrap}
          onCheckedChange={(wrap) => {
            setDiffOptions({ wrap });
          }}
        >
          {t('diff.wrap')}
        </MenuCheckboxItem>
        <MenuCheckboxItem
          checked={options.ignoreWhitespace}
          hint="git diff -w"
          onCheckedChange={(ignoreWhitespace) => {
            setDiffOptions({ ignoreWhitespace });
          }}
        >
          {t('diff.ignoreWhitespace')}
        </MenuCheckboxItem>
        <MenuCheckboxItem
          checked={options.fullFile}
          onCheckedChange={(fullFile) => {
            setDiffOptions({ fullFile });
          }}
        >
          {t('diff.fullFile')}
        </MenuCheckboxItem>
        <MenuSeparator />
        <MenuRadioGroup
          label={t('diff.context')}
          value={String(options.contextLines)}
          onValueChange={(value) => {
            setDiffOptions({ contextLines: Number(value) });
          }}
        >
          {CONTEXT_CHOICES.map((lines) => (
            <MenuRadioItem key={lines} value={String(lines)}>
              {t('diff.contextLines', { count: lines })}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </Menu>
    </div>
  );
}
