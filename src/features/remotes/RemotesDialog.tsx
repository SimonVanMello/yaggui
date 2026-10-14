import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { IconButton } from '../../ui/IconButton';
import { Spinner } from '../../ui/Spinner';
import { useRepoRefs } from '../sidebar/useRepoRefs';
import { openRemoteDialog, useRemoteDialogs, type RemoteDialog } from './remoteDialogsStore';
import { removeRemote } from './remoteOps';
import styles from './RemotesDialog.module.css';

type Props = Extract<RemoteDialog, { kind: 'manage' }>;

/** Remotes of the repository with their fetch and push URLs: add, edit, remove (F-125). */
export function RemotesDialog({ repoId }: Props) {
  const t = useT();
  const close = useRemoteDialogs((state) => state.close);
  const refs = useRepoRefs(repoId).data;
  const remotes = refs?.remotes ?? null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('remotes.manage.title')}
      description={t('remotes.manage.description')}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              openRemoteDialog({ kind: 'edit', repoId, remote: null, fromManage: true });
            }}
          >
            {t('remotes.manage.add')}
          </Button>
          {/* First focus here, not on the first row's buttons (their tooltip would open). */}
          <Button variant="primary" autoFocus onClick={close}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      {remotes === null ? (
        <Spinner />
      ) : remotes.length === 0 ? (
        <p className={styles.empty}>{t('remotes.manage.empty')}</p>
      ) : (
        <ul className={styles.list} aria-label={t('remotes.manage.title')}>
          {remotes.map((remote) => (
            <li key={remote.name} className={styles.remote}>
              <div className={styles.details}>
                <span className={styles.name}>{remote.name}</span>
                <span className={styles.url}>
                  <span className={styles.direction}>{t('remotes.manage.fetch')}</span>
                  <code title={remote.url ?? undefined}>
                    {remote.url ?? t('remotes.manage.noUrl')}
                  </code>
                </span>
                {remote.pushUrl !== null && (
                  <span className={styles.url}>
                    <span className={styles.direction}>{t('remotes.manage.push')}</span>
                    <code title={remote.pushUrl}>{remote.pushUrl}</code>
                  </span>
                )}
              </div>
              <IconButton
                icon="settings"
                size="sm"
                label={t('remotes.manage.edit', { name: remote.name })}
                onClick={() => {
                  openRemoteDialog({
                    kind: 'edit',
                    repoId,
                    remote: { name: remote.name, url: remote.url, pushUrl: remote.pushUrl },
                    fromManage: true,
                  });
                }}
              />
              <IconButton
                icon="trash"
                size="sm"
                label={t('remotes.manage.remove', { name: remote.name })}
                onClick={() => {
                  void removeRemote(repoId, remote.name);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
