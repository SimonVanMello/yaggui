import { useShortcut } from '../keybindings/registry';
import { Popover } from 'radix-ui';
import { useEffect, useState, type SubmitEvent } from 'react';

import { useT } from '../../i18n/useT';
import type { YagguiError, RepoState } from '../../ipc';
import { localize } from '../../app/errors/presentError';
import { Button } from '../../ui/Button';
import { activeRepoId } from '../repo/repoSessions';
import { changedFiles } from '../repo/repoStatus';
import { reportRefError, stashPush } from '../refs/refOps';
import { STASH_EVENT } from '../refs/refEvents';
import styles from './StashButton.module.css';
import { ToolbarButton } from './ToolbarButton';

/**
 * Toolbar Stash button and its popover (F-180, F-181): optional message, untracked files,
 * keep the index. `⌘⇧S` / `Ctrl+Shift+S` opens it from anywhere in the repository tab.
 */
export function StashButton({ repoId, state }: { repoId: number; state: RepoState }) {
  const t = useT();
  const stashShortcut = useShortcut('git.stash');
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [keepIndex, setKeepIndex] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<YagguiError | null>(null);
  const clean = changedFiles(state) === 0;

  useEffect(() => {
    const onStash = () => {
      if (activeRepoId() === repoId) setOpen(true);
    };
    window.addEventListener(STASH_EVENT, onStash);
    return () => {
      window.removeEventListener(STASH_EVENT, onStash);
    };
  }, [repoId]);

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (busy || clean) return;
    setBusy(true);
    setError(null);
    void stashPush(repoId, { message: message.trim() || null, includeUntracked, keepIndex }).then(
      (result) => {
        setBusy(false);
        if (result.ok || result.handled) {
          setOpen(false);
        } else if (result.error.code === 'nothingToStash') {
          setOpen(false);
          reportRefError(result.error);
        } else {
          setError(result.error);
        }
      },
    );
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setMessage('');
          setError(null);
        }
      }}
    >
      <Popover.Trigger asChild>
        <ToolbarButton
          icon="stash"
          label={t('toolbar.stash')}
          command="git stash push"
          shortcut={stashShortcut}
          onClick={() => undefined}
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={styles.popover} align="start" sideOffset={4}>
          <form className={styles.form} onSubmit={submit} aria-label={t('stash.popover.label')}>
            <label className={styles.field}>
              <span>{t('stash.popover.message')}</span>
              <input
                className={styles.input}
                value={message}
                autoFocus
                placeholder={t('stash.popover.placeholder')}
                spellCheck={false}
                onChange={(event) => {
                  setMessage(event.target.value);
                }}
              />
            </label>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={includeUntracked}
                onChange={(event) => {
                  setIncludeUntracked(event.target.checked);
                }}
              />
              <span>{t('stash.popover.untracked')}</span>
            </label>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={keepIndex}
                onChange={(event) => {
                  setKeepIndex(event.target.checked);
                }}
              />
              <span>{t('stash.popover.keepIndex')}</span>
            </label>
            {clean && <p className={styles.hint}>{t('stash.popover.clean')}</p>}
            {error && (
              <p className={styles.error} role="alert">
                {localize(error.message)}
              </p>
            )}
            <div className={styles.actions}>
              <Popover.Close asChild>
                <Button size="sm" variant="ghost">
                  {t('common.cancel')}
                </Button>
              </Popover.Close>
              <Button size="sm" variant="primary" type="submit" aria-disabled={clean || busy}>
                {t('stash.popover.submit')}
              </Button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
