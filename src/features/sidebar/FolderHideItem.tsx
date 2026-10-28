import { useT } from '../../i18n/useT';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import {
  folderFilterName,
  hiddenByFolder,
  isHidden,
  toggleHidden,
  updateGraphFilter,
  useGraphFilter,
} from '../graph/graphFilter';

/**
 * Hides a folder of branches from the graph, or shows it again (F-028): every branch whose name
 * starts with `path/`, including those created later.
 */
export function FolderHideItem({
  repoId,
  section,
  path,
}: {
  repoId: number;
  section: 'local' | 'remote';
  path: string;
}) {
  const t = useT();
  const filter = useGraphFilter(repoId);
  const name = folderFilterName(section, path);
  const hidden = isHidden(filter, name);
  // Hidden with a parent folder or with every remote branch: shown again from there.
  const why =
    hiddenByFolder(filter, name) !== null
      ? 'sidebar.why.hiddenFolder'
      : hidden && !filter.hidden.includes(name)
        ? 'sidebar.why.hiddenRemotes'
        : null;
  return (
    <ContextMenuItem
      icon={hidden ? 'eye' : 'eyeOff'}
      disabled={why !== null}
      hint={why !== null ? t(why) : undefined}
      onSelect={() => {
        void updateGraphFilter(repoId, (f) => toggleHidden(f, name));
      }}
    >
      {t(hidden ? 'sidebar.menu.showFolder' : 'sidebar.menu.hideFolder')}
    </ContextMenuItem>
  );
}
