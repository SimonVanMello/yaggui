import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useT } from '../../i18n/useT';
import { ipc, unwrap, type DiffTarget } from '../../ipc';
import { Spinner } from '../../ui/Spinner';
import { ChangedFileList } from './ChangedFileList';
import { DiffView } from './DiffView';
import { useChangedFiles } from './diffQueries';
import { closeDiff, openDiff, useDiffSelection } from './diffStore';
import { shortSha } from './format';
import styles from './DiffDemo.module.css';

const TAB = 'diff-demo';
const HEAD: DiffTarget = { kind: 'commits', from: null, to: 'HEAD' };
/** The mock's main repository; `#diff-demo:/abs/path` opens another one (real backend). */
const DEFAULT_PATH = '/Users/alex/dev/yaggui';

/**
 * `#diff-demo`: the HEAD commit's files and diff without the graph (M1-4 entry point until
 * the commit details of M1-2 integrate `ChangedFileList` and `DiffView`).
 */
export function DiffDemo({ path }: { path: string | null }) {
  const t = useT();
  const repo = useQuery({
    queryKey: ['diff-demo', path],
    queryFn: () => unwrap(ipc.commands.openRepo(path ?? DEFAULT_PATH)),
    staleTime: Infinity,
  });
  const repoId = repo.data?.id ?? -1;
  const files = useChangedFiles(repoId, repo.data ? HEAD : null).data;
  const selection = useDiffSelection(TAB);
  const head = repo.data?.state.head;
  const sha = head && head.kind !== 'unborn' ? shortSha(head.oid) : 'HEAD';

  // Opens the first file, so the demo shows a diff right away.
  const first = files?.files[0];
  useEffect(() => {
    if (first && !selection && repo.data) {
      openDiff(TAB, {
        repoId: repo.data.id,
        target: HEAD,
        path: first.path,
        oldPath: first.oldPath,
      });
    }
  }, [first, selection, repo.data]);

  if (!repo.data || !files) {
    return (
      <div className={styles.loading} role="status">
        <Spinner />
        {t('diff.demo.loading')}
      </div>
    );
  }
  return (
    <div className={styles.demo}>
      <main className={styles.center}>
        {selection ? (
          <DiffView
            selection={selection}
            onClose={() => {
              closeDiff(TAB);
            }}
            onSelect={(next) => {
              openDiff(TAB, next);
            }}
          />
        ) : (
          <p className={styles.hint}>{t('diff.demo.title')}</p>
        )}
      </main>
      <aside className={styles.side}>
        <ChangedFileList
          title={t('diff.commit.files', { sha })}
          files={files.files}
          statsSkipped={files.statsSkipped}
          lfsPaths={files.lfs}
          selectedPath={selection?.path ?? null}
          onSelect={(file) => {
            openDiff(TAB, { repoId, target: HEAD, path: file.path, oldPath: file.oldPath });
          }}
        />
      </aside>
    </div>
  );
}
