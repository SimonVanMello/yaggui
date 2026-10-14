import { useT } from '../../i18n/useT';
import type { ChangedFile, DiffTarget } from '../../ipc';
import { FileInspectMenu } from '../inspect/FileInspectButtons';
import { discardFiles, stageFiles, unstageFiles } from '../staging/stagingActions';
import { WorktreeFileMenu } from '../staging/WorktreeFileMenu';
import { ChangedFileList, type FileListStaging } from './ChangedFileList';
import { useChangedFiles, useWorktreeDiffRefresh } from './diffQueries';
import { closeDiff, openDiff, useDiffSelection } from './diffStore';
import styles from './WorktreeChanges.module.css';

const STAGED: DiffTarget = { kind: 'staged' };
const UNSTAGED: DiffTarget = { kind: 'unstaged' };

const paths = (files: readonly ChangedFile[]) => files.map((f) => f.path);

/**
 * Unstaged and staged files of the working tree (F-060, F-061): hover buttons, `Space`,
 * multi-selection and drag between the lists. A click opens the file's diff in place of the
 * graph; a click on the open file closes it.
 */
export function WorktreeChanges({ repoId, tabId }: { repoId: number; tabId: string }) {
  const t = useT();
  useWorktreeDiffRefresh(repoId);
  const staged = useChangedFiles(repoId, STAGED).data;
  const unstaged = useChangedFiles(repoId, UNSTAGED).data;
  const selection = useDiffSelection(tabId);
  const selected = (kind: DiffTarget['kind']) =>
    selection?.repoId === repoId && selection.target.kind === kind ? selection.path : null;
  const open = (target: DiffTarget) => (file: ChangedFile) => {
    openDiff(tabId, { repoId, target, path: file.path, oldPath: file.oldPath });
  };

  // The working tree version (a deleted file: blamed at HEAD by the backend).
  const fileMenu = (file: ChangedFile) => (
    <FileInspectMenu repoId={repoId} path={file.path} rev={null} />
  );

  const unstagedFiles = unstaged?.files ?? [];
  const unstagedActions: FileListStaging = {
    list: 'unstaged',
    onToggle: (files) => void stageFiles(repoId, paths(files)),
    onToggleAll: () => void stageFiles(repoId, 'all'),
    onDiscard: (files) => void discardFiles(repoId, files, false),
    onDiscardAll: () => void discardFiles(repoId, unstagedFiles, true),
    onDrop: (dropped) => void unstageFiles(repoId, dropped),
    menu: (targets) => (
      <WorktreeFileMenu
        repoId={repoId}
        list="unstaged"
        targets={targets}
        onToggle={(files) => void stageFiles(repoId, paths(files))}
        onDiscard={(files) => void discardFiles(repoId, files, false)}
      />
    ),
  };
  const stagedActions: FileListStaging = {
    list: 'staged',
    onToggle: (files) => void unstageFiles(repoId, paths(files)),
    onToggleAll: () => void unstageFiles(repoId, 'all'),
    onDrop: (dropped) => void stageFiles(repoId, dropped),
    menu: (targets) => (
      <WorktreeFileMenu
        repoId={repoId}
        list="staged"
        targets={targets}
        onToggle={(files) => void unstageFiles(repoId, paths(files))}
      />
    ),
  };

  return (
    <div className={styles.lists}>
      <ChangedFileList
        title={t('diff.wip.unstaged')}
        files={unstagedFiles}
        statsSkipped={unstaged?.statsSkipped}
        lfsPaths={unstaged?.lfs}
        selectedPath={selected('unstaged')}
        onDeselect={() => {
          closeDiff(tabId);
        }}
        onSelect={open(UNSTAGED)}
        emptyText={unstaged ? t('diff.wip.emptyUnstaged') : undefined}
        staging={unstagedActions}
        fileMenu={fileMenu}
        fit
      />
      <ChangedFileList
        title={t('diff.wip.staged')}
        files={staged?.files ?? []}
        statsSkipped={staged?.statsSkipped}
        lfsPaths={staged?.lfs}
        selectedPath={selected('staged')}
        onDeselect={() => {
          closeDiff(tabId);
        }}
        onSelect={open(STAGED)}
        emptyText={staged ? t('diff.wip.emptyStaged') : undefined}
        staging={stagedActions}
        fileMenu={fileMenu}
        fit
      />
    </div>
  );
}
