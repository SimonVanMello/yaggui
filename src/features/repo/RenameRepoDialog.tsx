import { useId, useState, type SubmitEvent } from 'react';

import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import type { KnownRepo, YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { TextInput } from '../../ui/TextInput';
import refStyles from '../refs/RefDialogs.module.css';
import { renameKnownRepo } from './knownRepoActions';
import { checkRepoName, folderName, MAX_REPO_NAME_LENGTH } from './repoName';
import { useRenameRepo } from './renameRepoStore';
import { useKnownRepos } from './useKnownRepos';

/** "Rename…" of a tab: the display name of its repository, everywhere it is listed. */
export function RenameRepoDialog() {
  const repoId = useRenameRepo((state) => state.repoId);
  const repo = useKnownRepos().data?.find((known) => known.id === repoId);
  return repo ? <RenameRepo key={repo.id} repo={repo} /> : null;
}

function RenameRepo({ repo }: { repo: KnownRepo }) {
  const t = useT();
  const close = useRenameRepo((state) => state.close);
  const [name, setName] = useState(repo.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<YagguiError | null>(null);
  const inputId = useId();
  const folder = folderName(repo.path);
  const check = checkRepoName(name);
  const canSubmit = check.ok && !busy;

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!check.ok || busy) return;
    setBusy(true);
    setError(null);
    void renameKnownRepo(repo.id, check.name).then((result) => {
      if (result.ok) close();
      else {
        setBusy(false);
        setError(result.error);
      }
    });
  };

  let status: string | null = null;
  if (!check.ok) status = t('repo.rename.tooLong', { max: MAX_REPO_NAME_LENGTH });
  else if (error) status = localize(error.message);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('repo.rename.title')}
      description={t('repo.rename.description')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="rename-repo" aria-disabled={!canSubmit}>
            {t('repo.rename.confirm')}
          </Button>
        </>
      }
    >
      <form id="rename-repo" className={refStyles.form} onSubmit={submit}>
        <label className={refStyles.field} htmlFor={inputId}>
          <span>{t('repo.rename.name')}</span>
          <TextInput
            id={inputId}
            autoFocus
            value={name}
            placeholder={folder}
            invalid={status !== null}
            aria-describedby={`${inputId}-hint`}
            onFocus={(event) => {
              event.currentTarget.select();
            }}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
          />
        </label>
        <p id={`${inputId}-hint`} className={refStyles.hint}>
          {t('repo.rename.hint', { folder })}
        </p>
        <p className={refStyles.status} data-state="invalid" role="alert">
          {status}
        </p>
      </form>
    </Dialog>
  );
}
