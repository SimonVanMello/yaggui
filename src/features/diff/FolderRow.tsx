import { Icon } from '../../ui/Icon';
import type { TreeFolder } from './fileTree';
import styles from './ChangedFileList.module.css';

export function FolderRow({
  folder,
  collapsed,
  onToggle,
}: {
  folder: TreeFolder;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      role="option"
      aria-selected={false}
      aria-expanded={!collapsed}
      className={`${styles.row} ${styles.folder}`}
      style={{
        paddingInlineStart: `calc(var(--space-4) + ${String(folder.depth)} * var(--space-5))`,
      }}
      onClick={onToggle}
      title={folder.path}
    >
      <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} className={styles.chevron} />
      <span className={styles.name}>
        <span className={styles.base}>{folder.name}</span>
      </span>
      <span className={styles.count}>{folder.fileCount}</span>
    </div>
  );
}
