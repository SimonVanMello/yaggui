import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '../../app/queryClient';
import { useShellStore } from '../../app/shellStore';
import { useAppInfo } from '../../app/useAppInfo';
import { useT } from '../../i18n/useT';
import { ipc } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Spinner } from '../../ui/Spinner';
import { checkForUpdatesNow } from '../updates/updates';
import { releaseKey } from './changelog';
import { ReleaseSection } from './ReleaseSection';
import styles from './ChangelogDialog.module.css';

/** "What's new": the release notes embedded in the app, newest first. */
export function ChangelogDialog() {
  const open = useShellStore((state) => state.changelogOpen);
  const t = useT();
  const appVersion = useAppInfo().data?.appVersion;
  const changelog = useQuery({
    queryKey: queryKeys.changelog,
    queryFn: () => ipc.commands.changelog(),
    staleTime: Infinity,
    enabled: open,
  });
  const close = () => {
    useShellStore.getState().setChangelogOpen(false);
  };

  return (
    <Dialog
      open={open}
      wide
      onOpenChange={(next) => {
        useShellStore.getState().setChangelogOpen(next);
      }}
      title={t('changelog.title')}
      description={
        appVersion ? t('changelog.description', { version: appVersion }) : t('changelog.loading')
      }
      footer={
        <>
          <Button onClick={() => void checkForUpdatesNow()}>{t('changelog.checkUpdates')}</Button>
          <Button variant="primary" onClick={close}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <div className={styles.releases}>
        {changelog.data === undefined ? (
          <Spinner />
        ) : changelog.data.length === 0 ? (
          <p className={styles.empty}>{t('changelog.empty')}</p>
        ) : (
          changelog.data.map((release) => (
            <ReleaseSection
              key={releaseKey(release)}
              release={release}
              installed={release.version !== null && release.version === appVersion}
            />
          ))
        )}
      </div>
    </Dialog>
  );
}
