import { useState } from 'react';

import { showYagguiError } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { ipc, type DiffTarget } from '../../ipc';
import { IconButton } from '../../ui/IconButton';
import { Menu } from '../../ui/Menu';
import { MenuItem } from '../../ui/MenuItem';
import { openInEditor } from '../terminal/openInEditor';

/**
 * The file of a diff outside yaggui (F-087): external editor and file manager (working tree
 * file), external diff tool (`git difftool` on the same comparison).
 */
export function ExternalDiffButtons({
  repoId,
  target,
  path,
  oldPath,
  deleted,
}: {
  repoId: number;
  target: DiffTarget;
  path: string;
  oldPath: string | null;
  /** Deleted by this diff: nothing to open in the working tree. */
  deleted: boolean;
}) {
  const t = useT();
  const [running, setRunning] = useState(false);
  const missing = deleted ? t('diff.external.deleted') : undefined;

  const runTool = async () => {
    setRunning(true);
    // Resolves when the tool is closed.
    const result = await ipc.commands.runDiffTool(repoId, target, path, oldPath);
    setRunning(false);
    if (result.status === 'error') {
      showYagguiError(result.error, {
        title: t('diff.external.toolFailed'),
        retry: () => void runTool(),
      });
    }
  };

  return (
    <Menu
      align="end"
      trigger={<IconButton icon="external" size="sm" label={t('diff.external.menu')} />}
    >
      <MenuItem
        icon="compare"
        disabled={running}
        hint={running ? t('diff.external.toolRunning') : undefined}
        onSelect={() => {
          void runTool();
        }}
      >
        {t('diff.external.tool')}
      </MenuItem>
      <MenuItem
        icon="external"
        disabled={deleted}
        hint={missing}
        onSelect={() => {
          void openInEditor(repoId, path);
        }}
      >
        {t('diff.external.editor')}
      </MenuItem>
      <MenuItem
        icon="folderOpen"
        disabled={deleted}
        hint={missing}
        onSelect={() => {
          void ipc.commands.revealPath(repoId, path).then((result) => {
            if (result.status === 'error') {
              showYagguiError(result.error, { title: t('diff.external.revealFailed') });
            }
          });
        }}
      >
        {t('diff.external.reveal')}
      </MenuItem>
    </Menu>
  );
}
