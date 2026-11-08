import { useQuery } from '@tanstack/react-query';

import { useShellStore } from '../../app/shellStore';
import { usePreferences } from '../../app/usePreferences';
import { useT } from '../../i18n/useT';
import { ipc, unwrap } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { gitStatus } from '../preferences/prefsLogic';
import { closeFirstRun } from './launchScreens';
import { DOCS_PAGES, openDocs } from './openDocs';
import styles from './FirstRunDialog.module.css';

/** The Git yaggui will run: version and path, a warning when too old, what to do when absent. */
export function FirstRunGit() {
  const t = useT();
  const gitPath = usePreferences().gitPath;
  const info = useQuery({
    queryKey: ['first-run', 'git-binary', gitPath] as const,
    queryFn: () => unwrap(ipc.commands.gitBinaryInfo(gitPath)),
    staleTime: Infinity,
  });
  if (info.data === undefined) {
    return (
      <p className={styles.status} data-kind="checking">
        {info.isError ? t('prefs.git.invalid') : t('prefs.git.checking')}
      </p>
    );
  }
  const status = gitStatus(info.data);
  if (status.kind === 'error') {
    return (
      <>
        <p className={styles.status} data-kind="error">
          <Icon name="error" className={styles.statusIcon} />
          <span>
            {status.reason === 'notFound' ? t('firstRun.git.notFound') : t('prefs.git.invalid')}
          </span>
        </p>
        <div className={styles.actions}>
          <Button
            onClick={() => {
              closeFirstRun();
              useShellStore.getState().setPreferencesOpen(true, 'tools');
            }}
          >
            {t('firstRun.git.choose')}
          </Button>
          <Button variant="ghost" onClick={() => void openDocs(DOCS_PAGES.installGit)}>
            <Icon name="external" />
            {t('firstRun.git.install')}
          </Button>
        </div>
      </>
    );
  }
  if (status.kind === 'checking') return null;
  return (
    <p className={styles.status} data-kind={status.kind}>
      <Icon name={status.kind === 'ok' ? 'check' : 'warning'} className={styles.statusIcon} />
      <span>
        {t('prefs.git.ok', { version: status.version, path: status.path })}
        {status.kind === 'old' && (
          <>
            <br />
            {t('prefs.git.old', { version: status.version, min: status.min })}
          </>
        )}
      </span>
    </p>
  );
}
