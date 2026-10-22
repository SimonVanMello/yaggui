import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useT } from '../../i18n/useT';
import { YagguiIpcError, type ChangedFile, type DiffTarget, type StashRef } from '../../ipc';
import { Button } from '../../ui/Button';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ChangedFileList } from '../diff/ChangedFileList';
import { useChangedFiles } from '../diff/diffQueries';
import { closeDiff, openDiff, useDiffSelection } from '../diff/diffStore';
import { shortOid } from '../repo/repoStatus';
import { stashId } from './refCommands';
import { stashApply, stashApplyFile, stashDrop, stashPop } from './refOps';
import styles from './StashPreviewPanel.module.css';

/** Details panel of a selected stash (F-183): its changed files, and the actions on it. */
export function StashPreviewPanel({
  repoId,
  tabId,
  stash,
}: {
  repoId: number;
  tabId: string;
  stash: StashRef;
}) {
  const t = useT();
  const target: DiffTarget = { kind: 'commits', from: null, to: stash.sha };
  const query = useChangedFiles(repoId, target);
  // Untracked files (`--include-untracked`) live in a parentless third commit: listed apart,
  // as files added by it.
  const untrackedTarget: DiffTarget | null = stash.untrackedSha
    ? { kind: 'commits', from: null, to: stash.untrackedSha }
    : null;
  const untracked = useChangedFiles(repoId, untrackedTarget);
  const selection = useDiffSelection(tabId);
  const selectedIn = (sha: string) =>
    selection?.repoId === repoId &&
    selection.target.kind === 'commits' &&
    selection.target.to === sha
      ? selection.path
      : null;
  const id = stashId(stash);
  // F-185: one file back into the working tree, the stash kept.
  const applyFile = (file: ChangedFile, untracked: boolean) => {
    void stashApplyFile(repoId, { stash: id, path: file.path, untracked });
  };
  const fileAction = (untracked: boolean) => (file: ChangedFile) => ({
    icon: 'pop' as const,
    label: t('stash.preview.applyFile'),
    onClick: () => {
      applyFile(file, untracked);
    },
  });
  const fileMenu = (untracked: boolean) => (file: ChangedFile) => (
    <ContextMenuItem
      icon="pop"
      onSelect={() => {
        applyFile(file, untracked);
      }}
    >
      {t('stash.preview.applyFile')}
    </ContextMenuItem>
  );

  return (
    <section className={styles.panel} aria-label={t('stash.preview.label')}>
      <header className={styles.header}>
        <h2 className={styles.title}>{stash.message}</h2>
        <p className={styles.meta}>
          <code>{stash.name}</code> · {t('stash.preview.base', { sha: shortOid(stash.baseSha) })}
        </p>
        <div className={styles.actions}>
          <Button
            size="sm"
            onClick={() => {
              void stashApply(repoId, id);
            }}
          >
            {t('sidebar.menu.stashApply')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              void stashPop(repoId, id);
            }}
          >
            {t('sidebar.menu.stashPop')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              void stashDrop(repoId, id, stash.message);
            }}
          >
            {t('stash.preview.drop')}
          </Button>
        </div>
      </header>
      <div className={styles.files}>
        {query.isError ? (
          <ErrorPanel
            compact
            title={t('stash.preview.failed')}
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
        ) : (
          <ChangedFileList
            title={t('stash.preview.files')}
            files={query.data?.files ?? []}
            statsSkipped={query.data?.statsSkipped}
            lfsPaths={query.data?.lfs}
            selectedPath={selectedIn(stash.sha)}
            onDeselect={() => {
              closeDiff(tabId);
            }}
            onSelect={(file: ChangedFile) => {
              openDiff(tabId, { repoId, target, path: file.path, oldPath: file.oldPath });
            }}
            emptyText={query.data ? t('stash.preview.empty') : undefined}
            fileAction={fileAction(false)}
            fileMenu={fileMenu(false)}
            fit
          />
        )}
        {untrackedTarget && stash.untrackedSha && !untracked.isError && (
          <ChangedFileList
            title={t('stash.preview.untracked')}
            files={untracked.data?.files ?? []}
            statsSkipped={untracked.data?.statsSkipped}
            lfsPaths={untracked.data?.lfs}
            selectedPath={selectedIn(stash.untrackedSha)}
            onDeselect={() => {
              closeDiff(tabId);
            }}
            onSelect={(file: ChangedFile) => {
              openDiff(tabId, {
                repoId,
                target: untrackedTarget,
                path: file.path,
                oldPath: file.oldPath,
              });
            }}
            fileAction={fileAction(true)}
            fileMenu={fileMenu(true)}
            fit
          />
        )}
      </div>
    </section>
  );
}
