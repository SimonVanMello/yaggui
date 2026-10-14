import { useId, useState, type SubmitEvent } from 'react';

import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import type { YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { fetchRepo } from '../network/networkOps';
import styles from '../refs/RefDialogs.module.css';
import { RefNameField } from '../refs/RefNameField';
import {
  leaveRemoteDialog,
  useRemoteDialogs,
  type RemoteDialog as Props,
} from './remoteDialogsStore';
import { addRemote, isNameError, saveRemote } from './remoteOps';
import { useRemoteNameCheck } from './useRemoteNameCheck';

type EditProps = Extract<Props, { kind: 'edit' }>;

/** Adds a remote, or edits one: name (rename), fetch URL and an optional distinct push URL (F-125). */
export function RemoteDialog({ repoId, remote }: EditProps) {
  const t = useT();
  const close = useRemoteDialogs((state) => state.close);
  const urlId = useId();
  const pushId = useId();
  const adding = remote === null;
  const [name, setName] = useState(remote?.name ?? '');
  const [url, setUrl] = useState(remote?.url ?? '');
  const [separatePush, setSeparatePush] = useState((remote?.pushUrl ?? null) !== null);
  const [pushUrl, setPushUrl] = useState(remote?.pushUrl ?? '');
  const [fetchAfter, setFetchAfter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<YagguiError | null>(null);
  const [urlError, setUrlError] = useState<YagguiError | null>(null);

  const unchangedName = remote !== null && name === remote.name;
  const check = useRemoteNameCheck(repoId, name, unchangedName);
  const wantedPush = separatePush && pushUrl.trim() !== '' ? pushUrl.trim() : null;
  const urlsChanged =
    remote === null || url.trim() !== (remote.url ?? '') || wantedPush !== remote.pushUrl;
  const canSubmit =
    name !== '' &&
    url.trim() !== '' &&
    (!separatePush || pushUrl.trim() !== '') &&
    check.status !== 'invalid' &&
    (adding || !unchangedName || urlsChanged) &&
    !busy;

  const fail = (error: YagguiError) => {
    if (isNameError(error)) setNameError(error);
    else setUrlError(error);
    setBusy(false);
  };

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setNameError(null);
    setUrlError(null);
    if (adding) {
      void addRemote(repoId, name, url, wantedPush).then((result) => {
        if (!result.ok) {
          fail(result.error);
          return;
        }
        leaveRemoteDialog();
        if (fetchAfter) void fetchRepo(repoId, { remote: name });
      });
      return;
    }
    void saveRemote(repoId, remote.name, {
      newName: unchangedName ? null : name,
      urls: urlsChanged ? { url, pushUrl: wantedPush } : null,
    }).then((result) => {
      if (result.ok) leaveRemoteDialog();
      else fail(result.error);
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) leaveRemoteDialog();
      }}
      title={adding ? t('remotes.add.title') : t('remotes.edit.title', { name: remote.name })}
      footer={
        <>
          <Button variant="ghost" onClick={adding ? close : leaveRemoteDialog}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="remote-form" aria-disabled={!canSubmit}>
            {adding ? t('remotes.add.confirm') : t('remotes.edit.confirm')}
          </Button>
        </>
      }
    >
      <form id="remote-form" className={styles.form} onSubmit={submit}>
        <RefNameField
          label={t('remotes.field.name')}
          value={name}
          onChange={(value) => {
            setName(value);
            setNameError(null);
          }}
          check={check}
          submitError={nameError}
          placeholder="origin"
          validText={t('remotes.name.valid')}
          autoFocus={adding}
        />
        <label className={styles.field} htmlFor={urlId}>
          <span>{t('remotes.field.url')}</span>
          <input
            id={urlId}
            className={`${styles.input} ${styles.mono}`}
            value={url}
            spellCheck={false}
            autoComplete="off"
            autoFocus={!adding}
            placeholder="git@github.com:owner/repo.git"
            aria-invalid={urlError !== null}
            onChange={(event) => {
              setUrl(event.target.value);
              setUrlError(null);
            }}
          />
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={separatePush}
            onChange={(event) => {
              setSeparatePush(event.target.checked);
              setUrlError(null);
            }}
          />
          <span>{t('remotes.field.separatePush')}</span>
        </label>
        {separatePush && (
          <label className={styles.field} htmlFor={pushId}>
            <span>{t('remotes.field.pushUrl')}</span>
            <input
              id={pushId}
              className={`${styles.input} ${styles.mono}`}
              value={pushUrl}
              spellCheck={false}
              autoComplete="off"
              placeholder="git@github.com:me/repo.git"
              aria-invalid={urlError !== null}
              onChange={(event) => {
                setPushUrl(event.target.value);
                setUrlError(null);
              }}
            />
          </label>
        )}
        <p className={styles.status} data-state={urlError ? 'invalid' : 'idle'} role="status">
          {urlError ? localize(urlError.message) : ''}
        </p>
        <p className={styles.hint}>{t('remotes.field.urlHint')}</p>
        {adding && (
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={fetchAfter}
              onChange={(event) => {
                setFetchAfter(event.target.checked);
              }}
            />
            <span>{t('remotes.field.fetchAfter')}</span>
          </label>
        )}
      </form>
    </Dialog>
  );
}
