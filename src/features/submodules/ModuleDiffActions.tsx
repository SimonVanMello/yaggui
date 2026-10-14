import { useT } from '../../i18n/useT';
import type { DiffContent, DiffTarget } from '../../ipc';
import { Button } from '../../ui/Button';
import { useLfsStatus } from '../lfs/lfsQueries';
import styles from '../lfs/Lfs.module.css';
import { openSubmodule, updateSubmodules } from './submoduleOps';
import { submoduleStatusOf, useSubmoduleStatus } from './submoduleQueries';
import actionStyles from './Submodules.module.css';

/** What the diff of a submodule or an LFS file offers under its summary (F-260, F-262). */
export function ModuleDiffActions({
  repoId,
  target,
  path,
  content,
}: {
  repoId: number;
  target: DiffTarget;
  path: string;
  content: DiffContent | null;
}) {
  if (content?.kind === 'submodule') {
    return <SubmoduleActions repoId={repoId} target={target} path={path} />;
  }
  if (content?.kind === 'lfs') return <LfsMissingNotice repoId={repoId} />;
  return null;
}

function SubmoduleActions({
  repoId,
  target,
  path,
}: {
  repoId: number;
  target: DiffTarget;
  path: string;
}) {
  const t = useT();
  const status = submoduleStatusOf(useSubmoduleStatus(repoId).data, path);
  if (!status) return null;
  // Only the working tree diff is the checked out commit moving away from the recorded one.
  const moved = target.kind === 'unstaged' && status.initialized && status.head !== status.expected;
  return (
    <>
      {status.dirty && <p className={actionStyles.note}>{t('submodule.alsoDirty')}</p>}
      <div className={actionStyles.actions}>
        {status.initialized && (
          <Button onClick={() => void openSubmodule(status)}>{t('submodule.open')}</Button>
        )}
        {moved && (
          <Button
            onClick={() =>
              void updateSubmodules(repoId, { paths: [path], init: false, recursive: false })
            }
          >
            {t('submodule.update')}
          </Button>
        )}
      </div>
    </>
  );
}

function LfsMissingNotice({ repoId }: { repoId: number }) {
  const t = useT();
  const status = useLfsStatus(repoId).data;
  if (!status || status.version !== null) return null;
  return (
    <p className={styles.notice} role="note">
      {t('lfs.notInstalled.text')}
    </p>
  );
}
