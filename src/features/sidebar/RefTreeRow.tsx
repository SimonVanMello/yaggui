import { useT } from '../../i18n/useT';
import { Highlight } from '../welcome/Highlight';
import { Icon, type IconName } from '../../ui/Icon';
import { shortOid } from '../repo/repoStatus';
import type { MessageKey } from '../../i18n/i18n';
import { startPress } from '../history/dnd/pointerDrag';
import type { FolderRow, RefRow, RefTarget, SidebarRow } from './sidebarRows';
import {
  BranchWorktreeMark,
  SubmoduleDetails,
  WorktreeDetails,
} from '../worktrees/ModuleRefDetails';
import { folderFilterName, isHidden, useGraphFilter } from '../graph/graphFilter';
import styles from './RefTree.module.css';

const SECTION_ICONS: Record<SidebarRow['section'], IconName> = {
  local: 'laptop',
  remote: 'cloud',
  tags: 'tag',
  stashes: 'stash',
  submodules: 'box',
  worktrees: 'folder',
};

const SECTION_TITLES: Record<SidebarRow['section'], MessageKey> = {
  local: 'sidebar.local',
  remote: 'sidebar.remote',
  tags: 'sidebar.tags',
  stashes: 'sidebar.stashes',
  submodules: 'sidebar.submodules',
  worktrees: 'sidebar.worktrees',
};

const EMPTY_TEXTS: Record<SidebarRow['section'], MessageKey> = {
  local: 'sidebar.empty.local',
  remote: 'sidebar.empty.remote',
  tags: 'sidebar.empty.tags',
  stashes: 'sidebar.empty.stashes',
  submodules: 'sidebar.empty.submodules',
  worktrees: 'sidebar.empty.worktrees',
};

function refIcon(target: RefTarget): IconName {
  switch (target.kind) {
    case 'head':
      return 'commit';
    case 'local':
    case 'remote':
      return 'branch';
    case 'tag':
      return 'tag';
    case 'stash':
      return 'stash';
    case 'submodule':
      return 'box';
    case 'worktree':
      return 'folder';
  }
}

function isCurrent(row: RefRow): boolean {
  const { target } = row;
  return (
    (target.kind === 'local' && target.branch.isHead) ||
    target.kind === 'head' ||
    (target.kind === 'worktree' && target.worktree.isCurrent)
  );
}

function RefDetails({ repoId, target }: { repoId: number; target: RefTarget }) {
  const t = useT();
  switch (target.kind) {
    case 'head':
      return target.head.kind === 'detached' ? (
        <span className={styles.meta}>{shortOid(target.head.oid)}</span>
      ) : null;
    case 'local': {
      const { upstream } = target.branch;
      const mark = (
        <BranchWorktreeMark repoId={repoId} branch={target.branch} className={styles.meta} />
      );
      if (!upstream) return mark;
      if (upstream.gone) {
        return (
          <>
            {mark}
            <span className={styles.gone}>{t('branch.upstreamGone')}</span>
          </>
        );
      }
      return (
        <>
          {mark}
          <span className={styles.aheadBehind}>
            {upstream.ahead > 0 && <b>↑{upstream.ahead}</b>}
            {upstream.behind > 0 && <em>↓{upstream.behind}</em>}
          </span>
        </>
      );
    }
    case 'tag':
      return target.tag.annotated ? <Icon name="info" className={styles.meta} /> : null;
    case 'worktree':
      return <WorktreeDetails worktree={target.worktree} lockClass={styles.meta} />;
    case 'submodule':
      return (
        <SubmoduleDetails
          repoId={repoId}
          submodule={target.submodule}
          notInitialized={t('sidebar.notInitialized')}
        />
      );
    default:
      return null;
  }
}

interface RefTreeRowProps {
  repoId: number;
  row: SidebarRow;
  id: string;
  index: number;
  active: boolean;
  selected: boolean;
  style: React.CSSProperties;
  sticky: boolean;
  onPress: (row: SidebarRow) => void;
  onOpen: (row: SidebarRow, element: HTMLElement) => void;
}

/** Full name of a branch row, the name a graph filter uses; `null` for other rows. */
function filterName(target: RefTarget): string | null {
  if (target.kind === 'local') return `refs/heads/${target.branch.name}`;
  if (target.kind === 'remote') return target.branch.fullName;
  if (target.kind === 'tag') return `refs/tags/${target.tag.name}`;
  return null;
}

/** Eye-off on a branch hidden from the graph, target on the soloed one (F-028). */
function FilterMark({ repoId, target }: { repoId: number; target: RefTarget }) {
  const t = useT();
  const filter = useGraphFilter(repoId);
  const name = filterName(target);
  if (name === null) return null;
  if (filter.solo === name) {
    return (
      <span
        className={styles.filterMark}
        title={t('sidebar.soloed')}
        aria-label={t('sidebar.soloed')}
      >
        <Icon name="solo" />
      </span>
    );
  }
  // The checked-out branch stays in the graph even inside a hidden folder.
  const isHead = target.kind === 'local' && target.branch.isHead;
  if (isHead || !isHidden(filter, name)) return null;
  return (
    <span
      className={styles.filterMark}
      title={t('sidebar.hidden')}
      aria-label={t('sidebar.hidden')}
    >
      <Icon name="eyeOff" />
    </span>
  );
}

/** Eye-off on a folder of branches hidden from the graph (F-028). */
function FolderFilterMark({ repoId, row }: { repoId: number; row: FolderRow }) {
  const t = useT();
  const filter = useGraphFilter(repoId);
  if (row.section !== 'local' && row.section !== 'remote') return null;
  if (!isHidden(filter, folderFilterName(row.section, row.path))) return null;
  return (
    <span
      className={styles.filterMark}
      title={t('sidebar.hiddenFolder')}
      aria-label={t('sidebar.hiddenFolder')}
    >
      <Icon name="eyeOff" />
    </span>
  );
}

/** One line of the refs tree: section header, folder, ref or placeholder. */
export function RefTreeRow({
  repoId,
  row,
  id,
  index,
  active,
  selected,
  style,
  sticky,
  onPress,
  onOpen,
}: RefTreeRowProps) {
  const t = useT();

  if (row.type === 'empty') {
    return (
      <div
        role="none"
        data-row-index={index}
        className={styles.empty}
        style={{ ...style, '--level': row.level } as React.CSSProperties}
      >
        {t(EMPTY_TEXTS[row.section])}
      </div>
    );
  }

  const common = {
    id,
    role: 'treeitem',
    'aria-level': row.level,
    'aria-posinset': row.posInSet,
    'aria-setsize': row.setSize,
    'data-row-index': index,
    'data-active': active || undefined,
    style: { ...style, '--level': row.level } as React.CSSProperties,
  } as const;

  if (row.type === 'section') {
    return (
      <div
        {...common}
        aria-expanded={row.expanded}
        aria-label={`${t(SECTION_TITLES[row.section])}, ${String(row.count)}`}
        className={[styles.row, styles.section, sticky ? styles.sticky : ''].join(' ')}
        onClick={() => {
          onPress(row);
        }}
      >
        <Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} className={styles.twisty} />
        <Icon name={SECTION_ICONS[row.section]} />
        <span className={styles.label}>{t(SECTION_TITLES[row.section])}</span>
        <span className={styles.count}>{row.count}</span>
      </div>
    );
  }

  if (row.type === 'folder') {
    return (
      <div
        {...common}
        aria-expanded={row.expanded}
        className={[styles.row, styles.folder].join(' ')}
        onClick={() => {
          onPress(row);
        }}
      >
        <Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} className={styles.twisty} />
        <Icon name={row.remote ? 'cloud' : row.expanded ? 'folderOpen' : 'folder'} />
        <span className={styles.label}>
          <Highlight text={row.label} indices={row.highlight} />
        </span>
        <FolderFilterMark repoId={repoId} row={row} />
        <span className={styles.count}>{row.count}</span>
      </div>
    );
  }

  const current = isCurrent(row);
  return (
    <div
      {...common}
      aria-selected={selected}
      aria-current={current ? 'true' : undefined}
      className={[styles.row, styles.ref].join(' ')}
      data-selected={selected || undefined}
      data-current={current || undefined}
      data-drop-branch={row.target.kind === 'local' ? row.target.branch.name : undefined}
      data-drop-repo={row.target.kind === 'local' ? repoId : undefined}
      onPointerDown={(event) => {
        const { target } = row;
        if (target.kind !== 'local' && target.kind !== 'remote') return;
        // Branches are dragged onto other branches (F-026): merge, rebase, fast-forward.
        startPress(event, () => ({
          repoId,
          payload: { kind: 'branch', name: target.branch.name, remote: target.kind === 'remote' },
          label: target.branch.name,
        }));
      }}
      onClick={() => {
        onPress(row);
      }}
      onDoubleClick={(event) => {
        onOpen(row, event.currentTarget);
      }}
    >
      <span className={styles.twisty} />
      <Icon name={refIcon(row.target)} />
      <span className={styles.label}>
        <Highlight text={row.label} indices={row.highlight} />
      </span>
      <FilterMark repoId={repoId} target={row.target} />
      <RefDetails repoId={repoId} target={row.target} />
    </div>
  );
}
