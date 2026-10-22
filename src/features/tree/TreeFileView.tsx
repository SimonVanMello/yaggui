import { useState } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { TreeFile } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Spinner } from '../../ui/Spinner';
import { formatBytes } from '../diff/format';
import { openBlame, openFileHistory } from '../inspect/inspectStore';
import { errorOf } from '../inspect/ipcError';
import { shortOid } from '../repo/repoStatus';
import { FileViewerLoader } from './FileViewerLoader';
import { copyTreePath, saveTreeVersion } from './treeActions';
import { resolveLinkTarget } from './treeModel';
import { useTreeFile } from './treeQueries';
import styles from './TreeView.module.css';

interface Props {
  repoId: number;
  sha: string;
  path: string;
  /** Selects a path of the tree (the target of a symbolic link). */
  onGoTo: (path: string) => void;
  /** Whether a path exists as a file or folder in the loaded part of the tree. */
  exists: (path: string) => boolean;
}

function Notice({
  icon,
  children,
}: {
  icon: 'file' | 'warning' | 'box';
  children: React.ReactNode;
}) {
  return (
    <div className={styles.notice}>
      <Icon name={icon} size="lg" />
      {children}
    </div>
  );
}

function Body({
  file,
  path,
  onGoTo,
  exists,
  onForce,
}: Pick<Props, 'path' | 'onGoTo' | 'exists'> & {
  file: TreeFile;
  onForce: () => void;
}) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const content = file.content;
  const size = formatBytes(file.size ?? 0, locale);
  switch (content.kind) {
    case 'text':
      return content.text === '' ? (
        <Notice icon="file">
          <span>{t('tree.file.empty')}</span>
        </Notice>
      ) : (
        <>
          {content.encoding === 'windows1252' && (
            <div className={styles.fileNote}>{t('diff.notice.encoding')}</div>
          )}
          <FileViewerLoader
            path={path}
            text={content.text}
            label={t('tree.file.label', { path })}
            wrap={false}
          />
        </>
      );
    case 'image':
      return (
        <div className={styles.image}>
          <img src={content.url} alt={path} />
        </div>
      );
    case 'binary':
      return (
        <Notice icon="file">
          <span>{t('tree.file.binary', { size })}</span>
        </Notice>
      );
    case 'tooLarge':
      return (
        <Notice icon="warning">
          <span>{t('tree.file.tooLarge', { size })}</span>
          <Button size="sm" onClick={onForce}>
            {t('tree.file.showAnyway')}
          </Button>
        </Notice>
      );
    case 'lfs':
      return (
        <Notice icon="box">
          <span>{t('tree.file.lfs', { size: formatBytes(content.object.size ?? 0, locale) })}</span>
          {content.object.oid && (
            <code className={styles.code}>
              {t('tree.file.lfsOid', { oid: content.object.oid })}
            </code>
          )}
        </Notice>
      );
    case 'symlink': {
      const target = resolveLinkTarget(path, content.target);
      return (
        <Notice icon="file">
          <span>{t('tree.file.symlink', { target: content.target })}</span>
          {target === null ? (
            <span className={styles.muted}>{t('tree.file.linkOutside')}</span>
          ) : exists(target) ? (
            <Button
              size="sm"
              onClick={() => {
                onGoTo(target);
              }}
            >
              {t('tree.file.followLink')}
            </Button>
          ) : (
            <span className={styles.muted}>{t('tree.file.linkMissing')}</span>
          )}
        </Notice>
      );
    }
    case 'submodule':
      return (
        <Notice icon="box">
          <span>{t('tree.file.submodule', { sha: shortOid(content.commit) })}</span>
        </Notice>
      );
  }
}

/** The file selected in the tree, as it was in the commit: header actions, then its content. */
export function TreeFileView(props: Props) {
  const { repoId, sha, path } = props;
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const [forced, setForced] = useState<string | null>(null);
  const force = forced === path;
  const query = useTreeFile(repoId, sha, path, force);
  const file = query.data;

  let body;
  if (query.isError) {
    body = (
      <div className={styles.notice}>
        <ErrorPanel
          title={t('tree.file.failed')}
          error={errorOf(query.error)}
          context={{ retry: () => void query.refetch() }}
        />
      </div>
    );
  } else if (!file) {
    body = (
      <div className={styles.notice} role="status">
        <Spinner />
        <span>{t('tree.file.loading')}</span>
      </div>
    );
  } else {
    body = (
      <Body
        path={path}
        onGoTo={props.onGoTo}
        exists={props.exists}
        file={file}
        onForce={() => {
          setForced(path);
        }}
      />
    );
  }
  const content = file?.content;
  const saveable = content !== undefined && content.kind !== 'submodule';

  return (
    <section
      className={styles.file}
      aria-label={t('tree.file.label', { path })}
      data-stale={query.isPlaceholderData}
    >
      <header className={styles.fileBar}>
        <span className={styles.filePath} title={path}>
          {path}
        </span>
        {file && content?.kind !== 'submodule' && (
          <span className={styles.chip}>{formatBytes(file.size ?? 0, locale)}</span>
        )}
        {file?.executable && <span className={styles.chip}>{t('tree.file.executable')}</span>}
        <span className={styles.spacer} />
        <IconButton
          icon="history"
          size="sm"
          label={t('inspect.action.history')}
          onClick={() => {
            openFileHistory(repoId, path, sha);
          }}
        />
        <IconButton
          icon="blame"
          size="sm"
          label={t('inspect.action.blameAt')}
          disabled={content?.kind === 'submodule' || content?.kind === 'symlink'}
          onClick={() => {
            openBlame(repoId, path, sha);
          }}
        />
        <IconButton
          icon="pop"
          size="sm"
          label={content?.kind === 'lfs' ? t('tree.action.savePointer') : t('tree.action.save')}
          disabled={!saveable}
          onClick={() => {
            void saveTreeVersion(repoId, sha, path);
          }}
        />
        <IconButton
          icon="copy"
          size="sm"
          label={t('tree.action.copyPath')}
          onClick={() => {
            copyTreePath(path);
          }}
        />
      </header>
      {body}
    </section>
  );
}
