import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useShellStore } from '../../app/shellStore';
import { translate, useI18nStore, type MessageKey } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { YagguiIpcError, ipc, unwrap, type YagguiError } from '../../ipc';
import { useYagguiEvent } from '../../ipc/useYagguiEvent';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { ProgressBar } from '../../ui/ProgressBar';
import { Spinner } from '../../ui/Spinner';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import { toast } from '../../ui/toastStore';
import { pickRepoFolder } from '../welcome/openRepository';
import { openRepoPath } from '../repo/repoSessions';
import {
  buildCloneRequest,
  joinPath,
  lastSegment,
  phaseKey,
  repoNameFromUrl,
  validateClone,
  type CloneForm,
} from './cloneForm';
import styles from './CloneDialog.module.css';

let cloneCounter = 0;

function newCloneId(): string {
  cloneCounter += 1;
  return `clone-${String(Date.now())}-${String(cloneCounter)}`;
}

interface Progress {
  phase: string;
  percent: number | null;
}

/** "Clone a repository" (F-002): address, destination, options, progress and cancellation. */
export function CloneDialog() {
  const dialog = useShellStore((state) => state.cloneDialog);
  return dialog ? <CloneFlow targetTabId={dialog.targetTabId} /> : null;
}

function CloneFlow({ targetTabId }: { targetTabId: string | null }) {
  const t = useT();
  const ids = { url: useId(), parent: useId(), name: useId(), branch: useId(), depth: useId() };
  const [form, setForm] = useState<CloneForm>({
    url: '',
    parent: '',
    name: '',
    branch: '',
    shallow: false,
    depth: '1',
    submodules: false,
  });
  const [nameEdited, setNameEdited] = useState(false);
  const [touched, setTouched] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<YagguiError | null>(null);
  const parentTouched = useRef(false);

  const close = () => {
    useShellStore.getState().closeCloneDialog();
  };

  useEffect(() => {
    let active = true;
    void unwrap(ipc.commands.newRepoDefaults())
      .then((defaults) => {
        if (!active || parentTouched.current || !defaults.parentDir) return;
        const parentDir = defaults.parentDir;
        setForm((current) => ({ ...current, parent: parentDir }));
      })
      .catch((failure: unknown) => {
        console.warn('Clone defaults unavailable', failure);
      });
    return () => {
      active = false;
    };
  }, []);

  useYagguiEvent('cloneProgress', (event) => {
    if (event.cloneId !== running) return;
    setProgress({ phase: event.phase, percent: event.percent });
  });

  const update = (patch: Partial<CloneForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setError(null);
  };

  const onUrl = (url: string) => {
    update({ url, ...(nameEdited ? {} : { name: repoNameFromUrl(url) }) });
  };

  const browse = async () => {
    try {
      const picked = await pickRepoFolder();
      if (!picked) return;
      parentTouched.current = true;
      update({ parent: picked });
    } catch (failure) {
      console.warn('Folder picker unavailable', failure);
      toast({ variant: 'warning', title: t('openDialog.pickerFailed') });
    }
  };

  const invalid = validateClone(form);

  const submit = async (event?: SyntheticEvent) => {
    event?.preventDefault();
    setTouched(true);
    if (invalid || running) return;
    const cloneId = newCloneId();
    setRunning(cloneId);
    setCancelling(false);
    setProgress(null);
    setError(null);
    try {
      const result = await unwrap(ipc.commands.cloneRepo(buildCloneRequest(form, cloneId)));
      close();
      toast({
        variant: 'success',
        title: t('clone.done', { name: lastSegment(result.path) }),
      });
      await openRepoPath(result.path, targetTabId ?? undefined);
    } catch (failure) {
      setRunning(null);
      setCancelling(false);
      if (failure instanceof YagguiIpcError) {
        // A cancellation is what the user asked for, not a failure to explain.
        if (failure.error.code !== 'cancelled') setError(failure.error);
      } else {
        console.error(failure);
      }
    }
  };

  const cancel = () => {
    if (!running || cancelling) return;
    setCancelling(true);
    void ipc.commands.cancelClone(running);
  };

  const phase = progress ? phaseLabel(progress.phase) : t('clone.connecting');
  const target = joinPath(form.parent, form.name.trim());

  return (
    <Dialog
      open
      wide
      onOpenChange={(next) => {
        // A running clone is stopped with its own button, never by a stray Escape.
        if (!next && !running) close();
      }}
      title={running ? t('clone.running', { name: form.name.trim() }) : t('clone.title')}
      description={running ? undefined : t('clone.description')}
    >
      {running ? (
        <div className={styles.progress}>
          <ProgressBar percent={progress?.percent ?? null} label={phase} />
          <div className={styles.phase} aria-live="polite">
            <span>
              {cancelling && <Spinner />} {cancelling ? t('clone.cancelling') : phase}
            </span>
            {progress?.percent != null && <span>{String(progress.percent)}%</span>}
          </div>
          <div className={styles.target}>{target}</div>
          <div className={styles.footer}>
            <Button variant="danger" disabled={cancelling} onClick={cancel}>
              {t('clone.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <form
          className={styles.form}
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <Field label={t('clone.url')} htmlFor={ids.url} hint={t('clone.url.hint')}>
            <TextInput
              id={ids.url}
              mono
              autoFocus
              value={form.url}
              placeholder={t('clone.url.placeholder')}
              invalid={touched && invalid === 'url'}
              onChange={(event) => {
                onUrl(event.target.value);
              }}
            />
          </Field>
          <div className={styles.pair}>
            <Field label={t('clone.parent')} htmlFor={ids.parent}>
              <div className={styles.row}>
                <TextInput
                  id={ids.parent}
                  mono
                  value={form.parent}
                  placeholder={t('clone.parent.placeholder')}
                  invalid={touched && invalid === 'parent'}
                  onChange={(event) => {
                    parentTouched.current = true;
                    update({ parent: event.target.value });
                  }}
                />
                <Button
                  onClick={() => {
                    void browse();
                  }}
                >
                  {t('clone.browse')}
                </Button>
              </div>
            </Field>
            <Field
              label={t('clone.name')}
              htmlFor={ids.name}
              hint={touched && invalid === 'name' ? t('clone.error.name') : undefined}
            >
              <TextInput
                id={ids.name}
                mono
                value={form.name}
                invalid={touched && invalid === 'name'}
                onChange={(event) => {
                  setNameEdited(true);
                  update({ name: event.target.value });
                }}
              />
            </Field>
          </div>
          {form.parent.trim() && form.name.trim() && (
            <div className={styles.target}>{t('clone.target', { path: target })}</div>
          )}
          <Field label={t('clone.branch')} htmlFor={ids.branch}>
            <TextInput
              id={ids.branch}
              mono
              value={form.branch}
              placeholder={t('clone.branch.placeholder')}
              onChange={(event) => {
                update({ branch: event.target.value });
              }}
            />
          </Field>
          <div className={styles.options}>
            <Switch
              checked={form.shallow}
              label={t('clone.shallow')}
              hint={t('clone.shallow.hint')}
              onCheckedChange={(shallow) => {
                update({ shallow });
              }}
            />
            {form.shallow && (
              <div className={styles.depth}>
                <Field
                  label={t('clone.depth')}
                  htmlFor={ids.depth}
                  hint={touched && invalid === 'depth' ? t('clone.error.depth') : undefined}
                >
                  <TextInput
                    id={ids.depth}
                    inputMode="numeric"
                    value={form.depth}
                    invalid={touched && invalid === 'depth'}
                    onChange={(event) => {
                      update({ depth: event.target.value });
                    }}
                  />
                </Field>
              </div>
            )}
            <Switch
              checked={form.submodules}
              label={t('clone.submodules')}
              hint={t('clone.submodules.hint')}
              onCheckedChange={(submodules) => {
                update({ submodules });
              }}
            />
          </div>
          {error && (
            <ErrorPanel
              compact
              title={t('clone.failed')}
              error={error}
              context={{ retry: () => void submit() }}
            />
          )}
          <div className={styles.footer}>
            <Button variant="ghost" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary">
              {t('clone.submit')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function phaseLabel(phase: string): string {
  const key = phaseKey(phase);
  return key
    ? translate(useI18nStore.getState().locale, `clone.phase.${key}` as MessageKey)
    : phase;
}
