import { useI18nStore } from '../../i18n/i18n';
import { formatRelativeTime } from '../../i18n/relativeTime';
import { useT } from '../../i18n/useT';
import type { KnownRepo, RepoOverview, RepoState } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Spinner } from '../../ui/Spinner';
import { Tooltip } from '../../ui/Tooltip';
import { repoColor } from '../repo/repoColor';
import styles from './OverviewRow.module.css';
import { useRepoOverview } from './workspaceQueries';
import { useWorkspaceUi } from './workspaceStore';

interface OverviewRowProps {
  repo: KnownRepo;
  now: number;
  onOpen: () => void;
  onRemove: () => void;
  onLocate: () => void;
}

function changeCount(state: RepoState): number {
  const { staged, unstaged, untracked, conflicted } = state.dirty;
  return staged + unstaged + untracked + conflicted;
}

function BranchCell({ state }: { state: RepoState }) {
  const t = useT();
  const head = state.head;
  const label =
    head.kind === 'detached'
      ? t('workspace.overview.detached', { sha: head.oid.slice(0, 7) })
      : head.name;
  return (
    <span className={styles.branch}>
      <Icon name="branch" />
      <span className={styles.ellipsis} title={label}>
        {label}
      </span>
      {state.operation && (
        <span className={styles.badge}>{t(`operation.${state.operation.kind}.short`)}</span>
      )}
    </span>
  );
}

function SyncCell({ state }: { state: RepoState }) {
  const t = useT();
  const upstream = state.upstream;
  if (!upstream) return <span className={styles.muted}>{t('workspace.overview.noUpstream')}</span>;
  if (upstream.gone) return <span className={styles.warning}>{t('workspace.overview.gone')}</span>;
  if (upstream.ahead === 0 && upstream.behind === 0) {
    return <span className={styles.muted}>{t('workspace.overview.upToDate')}</span>;
  }
  return (
    <span
      className={styles.sync}
      aria-label={t('workspace.overview.sync', { ahead: upstream.ahead, behind: upstream.behind })}
    >
      {upstream.ahead > 0 && <span>↑{String(upstream.ahead)}</span>}
      {upstream.behind > 0 && <span className={styles.behind}>↓{String(upstream.behind)}</span>}
    </span>
  );
}

function ChangesCell({ state }: { state: RepoState }) {
  const t = useT();
  const count = changeCount(state);
  if (state.dirty.conflicted > 0) {
    return (
      <span className={styles.danger}>
        {t('workspace.overview.conflicts', { count: state.dirty.conflicted })}
      </span>
    );
  }
  if (count === 0) return <span className={styles.muted}>{t('workspace.overview.clean')}</span>;
  return (
    <span className={styles.dirty}>
      <span className={styles.dirtyDot} aria-hidden="true" />
      {t('workspace.overview.changes', { count })}
    </span>
  );
}

function FetchCell({
  repoId,
  overview,
  now,
}: {
  repoId: number;
  overview: Extract<RepoOverview, { kind: 'ready' }>;
  now: number;
}) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const fetch = useWorkspaceUi((state) => state.fetches[repoId]);
  if (fetch?.status === 'running') {
    return (
      <span className={styles.muted}>
        <Spinner /> {t('workspace.overview.fetching')}
      </span>
    );
  }
  if (fetch?.status === 'failed') {
    return (
      <Tooltip content={fetch.error.message[locale]}>
        <span className={styles.danger} tabIndex={0}>
          <Icon name="error" /> {t('workspace.overview.fetchFailed')}
        </span>
      </Tooltip>
    );
  }
  return (
    <span className={styles.muted}>
      {overview.lastFetchedAt === null
        ? t('workspace.overview.neverFetched')
        : formatRelativeTime(overview.lastFetchedAt, now, locale)}
    </span>
  );
}

/** One repo of the workspace overview (F-008); a moved or deleted one offers its fixes (F-009). */
export function OverviewRow({ repo, now, onOpen, onRemove, onLocate }: OverviewRowProps) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const query = useRepoOverview(repo.id);
  const overview = query.data;

  let cells;
  if (!overview) {
    cells = query.error ? (
      <span className={`${styles.wide} ${styles.danger}`}>{query.error.message}</span>
    ) : (
      <span className={`${styles.wide} ${styles.muted}`}>
        <Spinner /> {t('workspace.overview.reading')}
      </span>
    );
  } else if (overview.kind === 'missing') {
    cells = (
      <span className={`${styles.wide} ${styles.missing}`}>
        <span className={styles.warning}>
          <Icon name="warning" />
          {t('workspace.overview.missing')}
        </span>
        <Button size="sm" onClick={onLocate}>
          {t('workspace.missing.locate')}
        </Button>
      </span>
    );
  } else if (overview.kind === 'failed') {
    cells = (
      <span
        className={`${styles.wide} ${styles.danger}`}
        title={overview.error.detail ?? undefined}
      >
        <Icon name="error" /> {overview.error.message[locale]}
      </span>
    );
  } else {
    cells = (
      <>
        <BranchCell state={overview.state} />
        <SyncCell state={overview.state} />
        <ChangesCell state={overview.state} />
        <FetchCell repoId={repo.id} overview={overview} now={now} />
      </>
    );
  }

  return (
    <div
      role="listitem"
      aria-label={repo.name}
      className={styles.row}
      data-missing={overview?.kind === 'missing' || undefined}
    >
      <span className={styles.repo}>
        <span className={styles.dot} style={{ background: repoColor(repo.name) }} />
        <span className={styles.repoText}>
          <span className={styles.name}>{repo.name}</span>
          <span className={styles.path} title={repo.path}>
            {repo.path}
          </span>
        </span>
      </span>
      {cells}
      <span className={styles.actions}>
        <IconButton
          size="sm"
          icon="folderOpen"
          label={t('workspace.overview.open', { name: repo.name })}
          disabled={overview?.kind === 'missing'}
          onClick={onOpen}
        />
        <IconButton
          size="sm"
          icon="minus"
          label={t('workspace.overview.remove', { name: repo.name })}
          onClick={onRemove}
        />
      </span>
    </div>
  );
}
