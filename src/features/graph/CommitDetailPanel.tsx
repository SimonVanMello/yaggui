import { useQuery } from '@tanstack/react-query';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useI18nStore } from '../../i18n/i18n';
import { formatRelativeTime } from '../../i18n/relativeTime';
import { useT } from '../../i18n/useT';
import {
  YagguiIpcError,
  ipc,
  unwrap,
  type ChangedFile,
  type DiffTarget,
  type Signature,
} from '../../ipc';
import { Spinner } from '../../ui/Spinner';
import { ChangedFileList } from '../diff/ChangedFileList';
import { useChangedFiles } from '../diff/diffQueries';
import { closeDiff, openDiff, useDiffSelection } from '../diff/diffStore';
import { FileInspectMenu } from '../inspect/FileInspectButtons';
import { useNow } from '../../ui/useNow';
import { Avatar } from './Avatar';
import { CommitMessageHeader } from './CommitMessageHeader';
import { CopyShaButton } from './CopyShaButton';
import styles from './CommitDetailPanel.module.css';
import type { GraphSource } from './graphSource';
import { RefPills } from './RefPills';
import { SignatureBadge } from './SignatureBadge';

function Person({ signature }: { signature: Signature }) {
  return (
    <>
      <span className={styles.avatarSlot}>
        <Avatar name={signature.name} email={signature.email} />
      </span>
      <span className={styles.personName}>{signature.name}</span>{' '}
      <span className={styles.muted}>&lt;{signature.email}&gt;</span>
    </>
  );
}

function SignatureTime({ time }: { time: number }) {
  const locale = useI18nStore((state) => state.locale);
  const now = useNow();
  return (
    <>
      {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
        time * 1000,
      )}
      <span className={styles.muted}>
        {' · '}
        <time dateTime={new Date(time * 1000).toISOString()}>
          {formatRelativeTime(time, now, locale)}
        </time>
      </span>
    </>
  );
}

function CommitFiles({ repoId, tabId, sha }: { repoId: number; tabId: string; sha: string }) {
  const t = useT();
  const target: DiffTarget = { kind: 'commits', from: null, to: sha };
  const query = useChangedFiles(repoId, target);
  const files = query.data;
  const selection = useDiffSelection(tabId);
  const selectedPath =
    selection?.repoId === repoId &&
    selection.target.kind === 'commits' &&
    selection.target.to === sha
      ? selection.path
      : null;
  if (query.isError) {
    const error =
      query.error instanceof YagguiIpcError
        ? query.error.error
        : {
            code: 'internal' as const,
            message: { en: query.error.message, fr: query.error.message },
            action: null,
            detail: null,
            payload: null,
          };
    return (
      <ErrorPanel
        compact
        title={t('graph.detail.filesFailed')}
        error={error}
        context={{ retry: () => void query.refetch() }}
      />
    );
  }
  return (
    <ChangedFileList
      title={t('diff.commit.files', { sha: sha.slice(0, 7) })}
      files={files?.files ?? []}
      statsSkipped={files?.statsSkipped}
      lfsPaths={files?.lfs}
      selectedPath={selectedPath}
      onDeselect={() => {
        closeDiff(tabId);
      }}
      onSelect={(file: ChangedFile) => {
        openDiff(tabId, { repoId, target, path: file.path, oldPath: file.oldPath });
      }}
      emptyText={files ? t('diff.commit.empty') : undefined}
      fileMenu={(file) => (
        <FileInspectMenu
          repoId={repoId}
          path={file.path}
          // A file the commit deleted is blamed in its parent.
          rev={file.status === 'deleted' ? `${sha}^` : sha}
        />
      )}
      fit
    />
  );
}

/** Right panel when a commit is selected: header from `commitDetail`, then its changed files. */
export function CommitDetailPanel({
  source,
  sha,
  repoId,
  tabId,
  busy,
}: {
  source: GraphSource;
  sha: string;
  repoId: number;
  tabId: string;
  /** A merge, rebase… is in progress: history cannot be rewritten. */
  busy: boolean;
}) {
  const t = useT();
  const detail = useQuery({
    queryKey: ['commit-detail', source.repoId, sha],
    queryFn: () => unwrap(ipc.commands.commitDetail(source.repoId, sha)),
    staleTime: Infinity,
  });

  if (detail.isPending) {
    return (
      <section className={styles.panel} aria-label={t('graph.detail.label')}>
        <div className={styles.loading} role="status">
          <Spinner />
        </div>
      </section>
    );
  }
  if (detail.isError) {
    const error =
      detail.error instanceof YagguiIpcError
        ? detail.error.error
        : {
            code: 'internal' as const,
            message: { en: detail.error.message, fr: detail.error.message },
            action: null,
            detail: null,
            payload: null,
          };
    return (
      <section className={styles.panel} aria-label={t('graph.detail.label')}>
        <ErrorPanel
          compact
          title={t('graph.detail.failed')}
          error={error}
          context={{ retry: () => void detail.refetch() }}
        />
      </section>
    );
  }

  const commit = detail.data;
  const sameSignature =
    commit.author.email === commit.committer.email && commit.author.time === commit.committer.time;
  return (
    <section className={styles.panel} aria-label={t('graph.detail.label')}>
      <CommitMessageHeader
        // A new commit starts out of edit mode.
        key={commit.sha}
        repoId={repoId}
        commit={commit}
        busy={busy}
        onReworded={(rewritten) => void source.followSha(rewritten)}
      />
      <div className={styles.scroll}>
        <dl className={styles.facts}>
          <dt>{t('graph.detail.author')}</dt>
          <dd>
            <Person signature={commit.author} />
          </dd>
          {commit.author.time !== null && (
            <>
              <dt>{t('graph.detail.date')}</dt>
              <dd>
                <SignatureTime time={commit.author.time} />
              </dd>
            </>
          )}
          {!sameSignature && (
            <>
              <dt>{t('graph.detail.committer')}</dt>
              <dd>
                <Person signature={commit.committer} />
                {commit.committer.time !== null && (
                  <>
                    {' · '}
                    <SignatureTime time={commit.committer.time} />
                  </>
                )}
              </dd>
            </>
          )}
          <dt>{t('graph.column.sha')}</dt>
          <dd>
            <CopyShaButton sha={commit.sha} />
          </dd>
          <dt>{t('graph.detail.parents')}</dt>
          <dd>
            {commit.parents.length === 0 ? (
              <span className={styles.muted}>{t('graph.detail.rootCommit')}</span>
            ) : (
              commit.parents.map((parent) => (
                <button
                  key={parent}
                  type="button"
                  className={styles.parent}
                  onClick={() => void source.goToSha(parent)}
                >
                  {parent.slice(0, 7)}
                </button>
              ))
            )}
          </dd>
          {commit.refs.length > 0 && (
            <>
              <dt>{t('graph.detail.refs')}</dt>
              <dd>
                <RefPills repoId={repoId} labels={commit.refs} color={0} />
              </dd>
            </>
          )}
          {commit.signature !== null && (
            <>
              <dt>{t('graph.detail.signature')}</dt>
              <dd>
                <SignatureBadge repoId={source.repoId} sha={commit.sha} kind={commit.signature} />
              </dd>
            </>
          )}
        </dl>
        <CommitFiles repoId={repoId} tabId={tabId} sha={commit.sha} />
      </div>
    </section>
  );
}
