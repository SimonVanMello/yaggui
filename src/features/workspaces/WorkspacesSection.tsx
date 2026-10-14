import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import styles from './WorkspacesSection.module.css';
import { openWorkspace } from './workspaceOps';
import { useWorkspaces } from './workspaceQueries';
import { useWorkspaceUi } from './workspaceStore';

/** Workspaces on the welcome screen (F-006): one click opens all their repos in tabs. */
export function WorkspacesSection({ tabId }: { tabId: string }) {
  const t = useT();
  const workspaces = useWorkspaces().data ?? [];
  const ui = useWorkspaceUi.getState();

  return (
    <section className={styles.section} aria-label={t('workspace.title')}>
      <div className={styles.header}>
        <h2 className={styles.title}>{t('workspace.title')}</h2>
        <span className={styles.links}>
          <button
            type="button"
            className={styles.link}
            onClick={() => {
              ui.openScan(null);
            }}
          >
            {t('workspace.scanFolder')}
          </button>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            className={styles.link}
            onClick={() => {
              ui.openManager(null);
            }}
          >
            {t('workspace.manage')}
          </button>
        </span>
      </div>
      {workspaces.length === 0 ? (
        <p className={styles.empty}>{t('workspace.welcome.empty')}</p>
      ) : (
        <ul className={styles.list}>
          {workspaces.map((workspace) => (
            <li key={workspace.id} className={styles.card}>
              <button
                type="button"
                className={styles.open}
                aria-label={t('workspace.openNamed', { name: workspace.name })}
                disabled={workspace.repoIds.length === 0}
                onClick={() => {
                  void openWorkspace(workspace, tabId);
                }}
              >
                <Icon name="box" />
                <span className={styles.name}>{workspace.name}</span>
                <span className={styles.count}>
                  {t('workspace.repoCount', { count: workspace.repoIds.length })}
                </span>
              </button>
              <IconButton
                size="sm"
                icon="list"
                label={t('workspace.overviewNamed', { name: workspace.name })}
                onClick={() => {
                  ui.openManager(workspace.id);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
