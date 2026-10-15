import type { Ref } from 'react';

import { ErrorPanel } from '../../../app/errors/ErrorPanel';
import { useT } from '../../../i18n/useT';
import { YagguiIpcError, type DiffTarget } from '../../../ipc';
import { Button } from '../../../ui/Button';
import { Spinner } from '../../../ui/Spinner';
import type { CodeDiffHandle } from '../CodeDiff';
import { useFileDiff } from '../diffQueries';
import styles from '../DiffView.module.css';
import { MarkdownDiffLoader } from './MarkdownDiffLoader';
import { textSides } from './textSides';

interface MarkdownPreviewProps {
  ref?: Ref<CodeDiffHandle>;
  repoId: number;
  target: DiffTarget;
  path: string;
  oldPath: string | null;
  force: boolean;
  /** Renders past the size guards ("Show anyway"). */
  onForce: () => void;
}

/** Whole-file diff of a Markdown file, rendered (F-089). */
export function MarkdownPreview({
  ref,
  repoId,
  target,
  path,
  oldPath,
  force,
  onForce,
}: MarkdownPreviewProps) {
  const t = useT();
  const query = useFileDiff(repoId, target, path, oldPath, {
    ignoreWhitespace: false,
    contextLines: 0,
    fullFile: true,
    force,
  });
  const diff = query.data?.path === path ? query.data : undefined;

  if (query.error) {
    const error =
      query.error instanceof YagguiIpcError
        ? query.error.error
        : {
            code: 'internal' as const,
            message: { en: query.error.message, fr: query.error.message },
            action: null,
            detail: null,
            payload: null,
          };
    return (
      <div className={styles.centered}>
        <ErrorPanel
          title={t('diff.failed')}
          error={error}
          context={{ retry: () => void query.refetch() }}
        />
      </div>
    );
  }
  if (!diff) {
    return (
      <div className={styles.centered} role="status">
        <Spinner />
      </div>
    );
  }
  // The whole file can exceed the size guards that the changed lines alone stayed under.
  if (diff.content.kind !== 'text') {
    return (
      <div className={`${styles.centered} ${styles.notice}`} role="status">
        <p>{t('diff.markdown.tooLarge')}</p>
        {diff.content.kind === 'tooLarge' && (
          <Button size="sm" onClick={onForce}>
            {t('diff.markdown.showAnyway')}
          </Button>
        )}
      </div>
    );
  }
  const sides = textSides(diff.content);
  // One instance per file: the change reached with n / p and the scroll start over.
  return (
    <MarkdownDiffLoader
      key={`${path}\u0000${oldPath ?? ''}`}
      ref={ref}
      oldText={sides.old}
      newText={sides.new}
    />
  );
}
