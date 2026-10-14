import { useT } from '../../i18n/useT';
import type { ChangedFile } from '../../ipc';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import type { WorktreeList } from '../diff/ChangedFileList';
import { copyText } from '../graph/CommitContextMenu';
import { openCommitToolsDialog } from './commitToolsStore';

interface WorktreeFileMenuProps {
  repoId: number;
  list: WorktreeList;
  /** Files the menu acts on (the selection, or the right-clicked file). */
  targets: () => ChangedFile[];
  onToggle: (files: ChangedFile[]) => void;
  onDiscard?: (files: ChangedFile[]) => void;
}

/**
 * Right-click menu of a working tree file: stage / unstage, discard, stash of the selected
 * files (F-182) and "Add to .gitignore" for an untracked file (F-069).
 */
export function WorktreeFileMenu({
  repoId,
  list,
  targets,
  onToggle,
  onDiscard,
}: WorktreeFileMenuProps) {
  const t = useT();
  const files = targets();
  const count = files.length;
  const [only] = files;
  const staged = list === 'staged';
  const stashable = files.filter((f) => f.status !== 'conflicted');
  return (
    <>
      <ContextMenuItem
        icon={staged ? 'minus' : 'plus'}
        onSelect={() => {
          onToggle(files);
        }}
      >
        {t(staged ? 'changes.unstageFiles' : 'changes.stageFiles', { count })}
      </ContextMenuItem>
      {onDiscard && (
        <ContextMenuItem
          icon="undo"
          danger
          onSelect={() => {
            onDiscard(files);
          }}
        >
          {t('changes.discardFiles', { count })}
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        icon="stash"
        disabled={stashable.length === 0}
        hint="git stash push -- <paths>"
        onSelect={() => {
          openCommitToolsDialog({
            kind: 'stashFiles',
            repoId,
            files: stashable.map((f) => ({ path: f.path, untracked: f.status === 'untracked' })),
          });
        }}
      >
        {t('stashFiles.menu', { count: stashable.length })}
      </ContextMenuItem>
      {count === 1 && only?.status === 'untracked' && (
        <ContextMenuItem
          icon="file"
          onSelect={() => {
            openCommitToolsDialog({ kind: 'gitignore', repoId, path: only.path });
          }}
        >
          {t('gitignore.menu')}
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        icon="copy"
        onSelect={() => {
          copyText(files.map((f) => f.path).join('\n'), t('changes.pathCopied', { count }));
        }}
      >
        {t('changes.copyPath', { count })}
      </ContextMenuItem>
    </>
  );
}
