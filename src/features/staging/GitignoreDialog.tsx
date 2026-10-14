import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { YagguiIpcError, ipc, unwrap, type GitignoreRuleKind } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import styles from './CommitToolsDialogs.module.css';
import { addToGitignore } from './commitToolsOps';
import { useCommitTools } from './commitToolsStore';

const KINDS: readonly GitignoreRuleKind[] = ['file', 'extension', 'folder'];

/**
 * "Add to .gitignore" for an untracked file (F-069): the file, its extension or its folder,
 * with the rule and the files it hides before anything is written.
 */
export function GitignoreDialog({ repoId, path }: { repoId: number; path: string }) {
  const t = useT();
  const close = useCommitTools((s) => s.close);
  const [kind, setKind] = useState<GitignoreRuleKind>('file');
  const [busy, setBusy] = useState(false);
  const preview = useQuery({
    queryKey: ['gitignore-preview', repoId, path, kind],
    queryFn: () => unwrap(ipc.commands.gitignorePreview(repoId, path, kind)),
    retry: false,
    staleTime: 0,
  });
  const data = preview.data;
  const invalid = preview.error instanceof YagguiIpcError ? preview.error.error : null;
  const canAdd = data !== undefined && !data.exists && !busy;

  const submit = () => {
    if (!canAdd) return;
    setBusy(true);
    void addToGitignore(repoId, path, kind).then((result) => {
      if (result.ok) close();
      else setBusy(false);
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('gitignore.title')}
      description={t('gitignore.description', { path })}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" aria-disabled={!canAdd} onClick={submit}>
            {t('gitignore.confirm')}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <fieldset className={styles.choices} aria-label={t('gitignore.kind')}>
          {KINDS.map((option) => (
            <label key={option} className={styles.choice}>
              <input
                type="radio"
                name="gitignore-kind"
                value={option}
                checked={kind === option}
                onChange={() => {
                  setKind(option);
                }}
              />
              {t(`gitignore.kind.${option}`)}
            </label>
          ))}
        </fieldset>
        {invalid ? (
          <p className={styles.error} role="alert">
            {localize(invalid.message)}
          </p>
        ) : data ? (
          <>
            <code className={styles.rule} aria-label={t('gitignore.rule')}>
              {data.rule}
            </code>
            {data.exists ? (
              <p className={styles.hint} role="status">
                {t('gitignore.exists')}
              </p>
            ) : (
              <>
                <p className={styles.hint}>{t('gitignore.matches', { count: data.matchCount })}</p>
                {data.matches.length > 0 && (
                  <ul className={styles.files}>
                    {data.matches.map((file) => (
                      <li key={file}>{file}</li>
                    ))}
                    {data.matchCount > data.matches.length && (
                      <li>
                        {t('gitignore.more', { count: data.matchCount - data.matches.length })}
                      </li>
                    )}
                  </ul>
                )}
                <p className={styles.hint}>{t('gitignore.undoHint')}</p>
              </>
            )}
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
