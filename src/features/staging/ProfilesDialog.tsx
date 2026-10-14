import { useQuery } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';

import { queryClient } from '../../app/queryClient';
import { localize, showError } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { YagguiIpcError, ipc, unwrap, type YagguiError, type IdentityProfile } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { IconButton } from '../../ui/IconButton';
import { TextInput } from '../../ui/TextInput';
import styles from './CommitToolsDialogs.module.css';
import { applyProfile, commitToolsKeys } from './commitToolsOps';
import { useCommitTools } from './commitToolsStore';

const EMPTY: IdentityProfile = { id: null, label: '', name: '', email: '' };

/**
 * Identity profiles (F-070): name / email pairs kept by yaggui, applied to a repository with
 * `git config --local`.
 */
export function ProfilesDialog({ repoId }: { repoId: number | null }) {
  const t = useT();
  const close = useCommitTools((s) => s.close);
  const profiles = useQuery({
    queryKey: commitToolsKeys.profiles(),
    queryFn: () => unwrap(ipc.commands.listIdentityProfiles()),
  });
  const identity = useQuery({
    queryKey: commitToolsKeys.identity(repoId ?? -1),
    queryFn: () => (repoId === null ? null : unwrap(ipc.commands.gitIdentity(repoId))),
  });
  const [editing, setEditing] = useState<IdentityProfile>(EMPTY);
  const [error, setError] = useState<YagguiError | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: commitToolsKeys.profiles() });
  const valid =
    editing.label.trim() !== '' &&
    editing.name.trim() !== '' &&
    /^[^\s<>@]+@[^\s<>@]+$/.test(editing.email.trim());

  const save = (event: SubmitEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    void unwrap(ipc.commands.saveIdentityProfile(editing))
      .then(() => {
        setEditing(EMPTY);
        setError(null);
        void refresh();
      })
      .catch((err: unknown) => {
        if (err instanceof YagguiIpcError) setError(err.error);
        else showError(err);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const remove = (id: number) => {
    void unwrap(ipc.commands.deleteIdentityProfile(id))
      .then(() => {
        if (editing.id === id) setEditing(EMPTY);
        void refresh();
      })
      .catch(showError);
  };

  const current = identity.data ?? null;
  const list = profiles.data ?? [];
  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('profiles.title')}
      description={t('profiles.description')}
      footer={
        <Button variant="ghost" onClick={close}>
          {t('common.close')}
        </Button>
      }
    >
      <div className={styles.body}>
        {list.length === 0 ? (
          <p className={styles.empty}>{t('profiles.empty')}</p>
        ) : (
          <ul className={styles.list} aria-label={t('profiles.title')}>
            {list.map((profile) => {
              const active = current?.name === profile.name && current.email === profile.email;
              return (
                <li
                  key={profile.id ?? profile.label}
                  className={styles.item}
                  data-editing={editing.id !== null && editing.id === profile.id}
                >
                  <span className={styles.itemText}>
                    <span className={styles.itemTitle}>{profile.label}</span>
                    <span className={styles.itemHint}>
                      {profile.name} &lt;{profile.email}&gt;
                    </span>
                  </span>
                  {repoId !== null && (
                    <Button
                      size="sm"
                      variant={active ? 'ghost' : 'secondary'}
                      aria-disabled={active}
                      onClick={() => {
                        if (!active) void applyProfile(repoId, profile);
                      }}
                    >
                      {active ? t('profiles.active') : t('profiles.apply')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(profile);
                      setError(null);
                    }}
                  >
                    {t('profiles.edit')}
                  </Button>
                  {profile.id !== null && (
                    <IconButton
                      size="sm"
                      icon="trash"
                      label={t('profiles.delete', { label: profile.label })}
                      onClick={() => {
                        if (profile.id !== null) remove(profile.id);
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {repoId !== null && <p className={styles.hint}>{t('profiles.applyHint')}</p>}
        <form className={styles.form} onSubmit={save} aria-label={t('profiles.form')}>
          <p className={styles.formTitle}>
            {editing.id === null ? t('profiles.new') : t('profiles.editing')}
          </p>
          <Field label={t('profiles.label')} htmlFor="profile-label">
            <TextInput
              id="profile-label"
              value={editing.label}
              placeholder={t('profiles.labelPlaceholder')}
              onChange={(event) => {
                setEditing({ ...editing, label: event.target.value });
                setError(null);
              }}
            />
          </Field>
          <div className={styles.row}>
            <Field label={t('identity.name')} htmlFor="profile-name">
              <TextInput
                id="profile-name"
                value={editing.name}
                autoComplete="name"
                onChange={(event) => {
                  setEditing({ ...editing, name: event.target.value });
                  setError(null);
                }}
              />
            </Field>
            <Field label={t('identity.email')} htmlFor="profile-email">
              <TextInput
                id="profile-email"
                type="email"
                value={editing.email}
                autoComplete="email"
                onChange={(event) => {
                  setEditing({ ...editing, email: event.target.value });
                  setError(null);
                }}
              />
            </Field>
          </div>
          {error && (
            <p className={styles.error} role="alert">
              {localize(error.message)}
            </p>
          )}
          <div className={styles.formActions}>
            {current?.name && current.email && editing.id === null && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing({ ...editing, name: current.name ?? '', email: current.email ?? '' });
                }}
              >
                {t('profiles.fromCurrent')}
              </Button>
            )}
            {editing.id !== null && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing(EMPTY);
                  setError(null);
                }}
              >
                {t('common.cancel')}
              </Button>
            )}
            <Button size="sm" variant="primary" type="submit" aria-disabled={!valid || busy}>
              {editing.id === null ? t('profiles.add') : t('profiles.save')}
            </Button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
