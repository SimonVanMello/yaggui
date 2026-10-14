import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Menu } from '../../ui/Menu';
import { MenuCheckboxItem } from '../../ui/MenuCheckboxItem';
import {
  isFilterActive,
  shortName,
  showAll,
  updateGraphFilter,
  useGraphFilter,
} from './graphFilter';
import styles from './GraphFilterBar.module.css';

/**
 * Says that the graph does not show every ref (F-028): soloed branch, hidden refs, hidden
 * remotes or stashes, with the way back to everything.
 */
export function GraphFilterBar({ repoId }: { repoId: number }) {
  const t = useT();
  const filter = useGraphFilter(repoId);
  if (!isFilterActive(filter)) return null;
  const parts: string[] = [];
  if (filter.solo !== null) parts.push(t('graph.filter.solo', { name: shortName(filter.solo) }));
  if (filter.hidden.length > 0) {
    parts.push(
      t('graph.filter.hidden', {
        count: filter.hidden.length,
        name: shortName(filter.hidden[0] ?? ''),
      }),
    );
  }
  if (filter.hideRemotes) parts.push(t('graph.filter.remotes'));
  if (filter.hideStashes) parts.push(t('graph.filter.stashes'));
  return (
    <div className={styles.bar} role="status" aria-label={t('graph.filter.label')}>
      <Icon name={filter.solo !== null ? 'solo' : 'eyeOff'} />
      <span className={styles.text} title={filter.hidden.map(shortName).join('\n') || undefined}>
        {parts.join(' · ')}
      </span>
      <Menu
        align="end"
        trigger={<IconButton icon="settings" size="sm" label={t('graph.filter.menu')} />}
      >
        <MenuCheckboxItem
          checked={filter.hideRemotes}
          onCheckedChange={(hideRemotes) => {
            void updateGraphFilter(repoId, (f) => ({ ...f, hideRemotes }));
          }}
        >
          {t('graph.filter.hideRemotes')}
        </MenuCheckboxItem>
        <MenuCheckboxItem
          checked={filter.hideStashes}
          onCheckedChange={(hideStashes) => {
            void updateGraphFilter(repoId, (f) => ({ ...f, hideStashes }));
          }}
        >
          {t('graph.filter.hideStashes')}
        </MenuCheckboxItem>
      </Menu>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          void showAll(repoId);
        }}
      >
        <Icon name="eye" />
        {t('graph.filter.showAll')}
      </Button>
    </div>
  );
}
