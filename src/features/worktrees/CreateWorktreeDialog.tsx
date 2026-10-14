import { useId, useState, type SubmitEvent } from 'react';

import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { ipc, unwrap, type YagguiError, type WorktreeBranch } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { TextInput } from '../../ui/TextInput';
import { RefNameField } from '../refs/RefNameField';
import { useRefNameCheck } from '../refs/useRefNameCheck';
import { useRepoSessions } from '../repo/repoSessions';
import { useRepoRefs } from '../sidebar/useRepoRefs';
import refStyles from '../refs/RefDialogs.module.css';
import { createWorktree, suggestWorktreePath, worktreeBranch } from './worktreeOps';
import { useWorktreeDialogs } from './worktreeStore';
import styles from './Worktrees.module.css';

type Mode = 'new' | 'existing';

/** Creates a linked worktree on a new or an existing branch, in a chosen folder (F-261). */
export function CreateWorktreeDialog({
  repoId,
  branch: preset,
}: {
  repoId: number;
  branch: string | null;
}) {
  const t = useT();
  const close = useWorktreeDialogs((state) => state.close);
  const refs = useRepoRefs(repoId).data;
  const repoPath = useRepoSessions((state) => {
    const session = state.sessions[repoId];
    return session?.status === 'open' ? session.info.path : '';
  });
  const busyBranches = new Set(
    (refs?.worktrees ?? []).flatMap((w) => {
      const name = worktreeBranch(w);
      return name ? [name] : [];
    }),
  );
  const free = (refs?.local ?? []).filter((b) => !busyBranches.has(b.name)).map((b) => b.name);
  const head = refs?.head;
  const headName = head && head.kind !== 'detached' ? head.name : 'HEAD';

  const [mode, setMode] = useState<Mode>(preset ? 'existing' : 'new');
  const [name, setName] = useState('');
  const [start, setStart] = useState<string | null>(null);
  const [existing, setExisting] = useState<string | null>(preset);
  const [folder, setFolder] = useState<string | null>(null);
  const [openTab, setOpenTab] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<YagguiError | null>(null);
  const check = useRefNameCheck(repoId, 'branch', mode === 'new' ? name : '');
  const folderId = useId();
  const startId = useId();
  const branchId = useId();

  const chosen = existing ?? free[0] ?? null;
  const branchName = mode === 'new' ? name.trim() : (chosen ?? '');
  const startRev = start ?? headName;
  // The folder follows the branch until it is edited.
  const path = folder ?? (repoPath && branchName ? suggestWorktreePath(repoPath, branchName) : '');
  const target: WorktreeBranch | null =
    mode === 'new'
      ? name && check.status !== 'invalid'
        ? { kind: 'new', name: name.trim(), start: startRev.trim() }
        : null
      : chosen
        ? { kind: 'existing', name: chosen }
        : null;
  const canSubmit = target !== null && path.trim() !== '' && !busy;

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    void createWorktree(repoId, { path: path.trim(), branch: target }, openTab).then((result) => {
      if (result.ok) close();
      else {
        setBusy(false);
        setError(result.error);
      }
    });
  };

  const browse = async () => {
    try {
      const picked = await unwrap(ipc.commands.pickRepoFolder(t('worktree.create.pickTitle')));
      if (picked) setFolder(picked);
    } catch {
      // The picker failed to open: the path can still be typed.
    }
  };

  const command =
    mode === 'new'
      ? `git worktree add -b ${branchName || '<branch>'} -- ${path || '<folder>'} ${startRev}`
      : `git worktree add -- ${path || '<folder>'} ${branchName || '<branch>'}`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('worktree.create.title')}
      description={t('worktree.create.description')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="create-worktree" aria-disabled={!canSubmit}>
            {t('worktree.create.confirm')}
          </Button>
        </>
      }
    >
      <form id="create-worktree" className={refStyles.form} onSubmit={submit}>
        <SegmentedControl<Mode>
          label={t('worktree.create.title')}
          value={mode}
          options={[
            { value: 'new', label: t('worktree.create.newBranch') },
            { value: 'existing', label: t('worktree.create.existingBranch') },
          ]}
          onChange={(value) => {
            setMode(value);
            setError(null);
          }}
        />
        {mode === 'new' ? (
          <>
            <RefNameField
              label={t('worktree.create.branchName')}
              value={name}
              onChange={(value) => {
                setName(value);
                setError(null);
              }}
              check={check}
              submitError={error?.code === 'refExists' ? error : null}
              placeholder="feature/my-branch"
            />
            <label className={refStyles.field} htmlFor={startId}>
              <span>{t('worktree.create.start')}</span>
              <TextInput
                id={startId}
                mono
                value={startRev}
                onChange={(event) => {
                  setStart(event.target.value);
                }}
              />
            </label>
          </>
        ) : free.length === 0 ? (
          <p className={refStyles.hint}>{t('worktree.create.noBranch')}</p>
        ) : (
          <label className={refStyles.field} htmlFor={branchId}>
            <span>{t('worktree.create.branch')}</span>
            <select
              id={branchId}
              className={`${refStyles.select} ${refStyles.mono}`}
              value={chosen ?? ''}
              onChange={(event) => {
                setExisting(event.target.value);
                setError(null);
              }}
            >
              {free.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className={refStyles.field}>
          <label htmlFor={folderId}>{t('worktree.create.folder')}</label>
          <div className={styles.folderRow}>
            <TextInput
              id={folderId}
              mono
              value={path}
              invalid={error?.code === 'targetNotEmpty'}
              onChange={(event) => {
                setFolder(event.target.value);
                setError(null);
              }}
            />
            <Button type="button" onClick={() => void browse()}>
              {t('worktree.create.browse')}
            </Button>
          </div>
          <p className={refStyles.hint}>{t('worktree.create.folderHint')}</p>
        </div>
        <label className={refStyles.check}>
          <input
            type="checkbox"
            checked={openTab}
            onChange={(event) => {
              setOpenTab(event.target.checked);
            }}
          />
          <span>{t('worktree.create.open')}</span>
        </label>
        {error && error.code !== 'refExists' && (
          <p className={refStyles.status} data-state="invalid" role="alert">
            {localize(error.message)}
          </p>
        )}
        <code className={refStyles.command}>{command}</code>
      </form>
    </Dialog>
  );
}
