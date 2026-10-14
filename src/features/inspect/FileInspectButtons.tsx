import { useT } from '../../i18n/useT';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { IconButton } from '../../ui/IconButton';
import { openBlame, openFileHistory } from './inspectStore';

interface FileInspectProps {
  repoId: number;
  path: string;
  /** Version of the file: a commit, or `null` for the working tree. */
  rev: string | null;
}

/** "File history" and "Blame" for the file of a diff (toolbar buttons). */
export function FileInspectButtons({
  repoId,
  path,
  rev,
  history = true,
}: FileInspectProps & { history?: boolean }) {
  const t = useT();
  return (
    <>
      {history && (
        <IconButton
          icon="history"
          size="sm"
          label={t('inspect.action.history')}
          onClick={() => {
            openFileHistory(repoId, path);
          }}
        />
      )}
      <IconButton
        icon="blame"
        size="sm"
        label={rev === null ? t('inspect.action.blame') : t('inspect.action.blameAt')}
        onClick={() => {
          openBlame(repoId, path, rev);
        }}
      />
    </>
  );
}

/** The same actions in the right-click menu of a changed file. */
export function FileInspectMenu({ repoId, path, rev }: FileInspectProps) {
  const t = useT();
  return (
    <>
      <ContextMenuItem
        icon="history"
        onSelect={() => {
          openFileHistory(repoId, path);
        }}
      >
        {t('inspect.action.history')}
      </ContextMenuItem>
      <ContextMenuItem
        icon="blame"
        onSelect={() => {
          openBlame(repoId, path, rev);
        }}
      >
        {rev === null ? t('inspect.action.blame') : t('inspect.action.blameAt')}
      </ContextMenuItem>
    </>
  );
}
