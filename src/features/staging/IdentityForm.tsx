import { useQuery } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';

import { showError } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { ipc, unwrap, type ConfigScope } from '../../ipc';
import { Button } from '../../ui/Button';
import styles from './IdentityForm.module.css';

interface IdentityFormProps {
  repoId: number;
  /** Called with `true` once the identity is saved, `false` when dismissed. */
  onDone: (saved: boolean) => void;
}

/** Git does not know who the user is: asks for `user.name` / `user.email` and writes them. */
export function IdentityForm({ repoId, onDone }: IdentityFormProps) {
  const identity = useQuery({
    queryKey: ['git-identity', repoId],
    queryFn: () => unwrap(ipc.commands.gitIdentity(repoId)),
    staleTime: 0,
    gcTime: 0,
  });
  // Remounts with the values Git already has (one of the two may be set).
  if (!identity.data) return null;
  return (
    <Fields
      repoId={repoId}
      initial={{ name: identity.data.name ?? '', email: identity.data.email ?? '' }}
      onDone={onDone}
    />
  );
}

function Fields({
  repoId,
  initial,
  onDone,
}: IdentityFormProps & { initial: { name: string; email: string } }) {
  const t = useT();
  const [name, setName] = useState(initial.name);
  const [email, setEmail] = useState(initial.email);
  const [repoOnly, setRepoOnly] = useState(false);
  const [saving, setSaving] = useState(false);
  const scope: ConfigScope = repoOnly ? 'repo' : 'global';
  const valid = name.trim() !== '' && /^[^\s<>@]+@[^\s<>@]+$/.test(email.trim());

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    void unwrap(ipc.commands.setGitIdentity(repoId, name.trim(), email.trim(), scope))
      .then(() => {
        onDone(true);
      })
      .catch((error: unknown) => {
        showError(error);
        setSaving(false);
      });
  };

  return (
    <form
      className={styles.form}
      aria-label={t('identity.title')}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onDone(false);
        }
      }}
    >
      <b className={styles.title}>{t('identity.title')}</b>
      <p className={styles.hint}>{t('identity.hint')}</p>
      <label className={styles.field}>
        <span>{t('identity.name')}</span>
        <input
          className={styles.input}
          value={name}
          autoComplete="name"
          autoFocus={name === ''}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </label>
      <label className={styles.field}>
        <span>{t('identity.email')}</span>
        <input
          className={styles.input}
          type="email"
          value={email}
          autoComplete="email"
          autoFocus={name !== '' && email === ''}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
      </label>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={repoOnly}
          onChange={(event) => {
            setRepoOnly(event.target.checked);
          }}
        />
        {t('identity.repoOnly')}
      </label>
      <div className={styles.actions}>
        <Button type="submit" variant="primary" size="sm" aria-disabled={!valid || saving}>
          {t('identity.save')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onDone(false);
          }}
        >
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
