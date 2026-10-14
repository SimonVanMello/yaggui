import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useShellStore } from '../../app/shellStore';
import type { MessageKey } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { YagguiIpcError, ipc, unwrap, type GitignoreTemplate, type YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import { toast } from '../../ui/toastStore';
import { openRepoPath } from '../repo/repoSessions';
import { pickRepoFolder } from '../welcome/openRepository';
import {
  buildInitRequest,
  lastSegment,
  toggleTemplate,
  validateInit,
  type InitForm,
} from './cloneForm';
import styles from './InitDialog.module.css';

const TEMPLATES: readonly GitignoreTemplate[] = [
  'node',
  'rust',
  'dotNet',
  'python',
  'macOs',
  'windows',
];

/** "Initialize a repository" (F-003): folder, default branch, `.gitignore` templates, README. */
export function InitDialog() {
  const dialog = useShellStore((state) => state.initDialog);
  return dialog ? <InitFlow targetTabId={dialog.targetTabId} /> : null;
}

function InitFlow({ targetTabId }: { targetTabId: string | null }) {
  const t = useT();
  const ids = { folder: useId(), branch: useId() };
  const [form, setForm] = useState<InitForm>({
    folder: '',
    branch: 'main',
    gitignore: [],
    readme: false,
  });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<YagguiError | null>(null);
  const branchEdited = useRef(false);

  const close = () => {
    useShellStore.getState().closeInitDialog();
  };

  useEffect(() => {
    let active = true;
    void unwrap(ipc.commands.newRepoDefaults())
      .then((defaults) => {
        if (!active || branchEdited.current) return;
        setForm((current) => ({ ...current, branch: defaults.defaultBranch }));
      })
      .catch((failure: unknown) => {
        console.warn('Init defaults unavailable', failure);
      });
    return () => {
      active = false;
    };
  }, []);

  const update = (patch: Partial<InitForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setError(null);
  };

  const browse = async () => {
    try {
      const picked = await pickRepoFolder();
      if (picked) update({ folder: picked });
    } catch (failure) {
      console.warn('Folder picker unavailable', failure);
      toast({ variant: 'warning', title: t('openDialog.pickerFailed') });
    }
  };

  const invalid = validateInit(form);

  const submit = async (event?: SyntheticEvent) => {
    event?.preventDefault();
    setTouched(true);
    if (invalid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await unwrap(ipc.commands.initRepo(buildInitRequest(form)));
      close();
      toast({ variant: 'success', title: t('init.done', { name: lastSegment(result.path) }) });
      await openRepoPath(result.path, targetTabId ?? undefined);
    } catch (failure) {
      setBusy(false);
      if (failure instanceof YagguiIpcError) setError(failure.error);
      else console.error(failure);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) close();
      }}
      title={t('init.title')}
      description={t('init.description')}
    >
      <form
        className={styles.form}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field label={t('init.folder')} htmlFor={ids.folder} hint={t('init.folder.hint')}>
          <div className={styles.row}>
            <TextInput
              id={ids.folder}
              mono
              autoFocus
              value={form.folder}
              placeholder={t('init.folder.placeholder')}
              invalid={touched && invalid === 'folder'}
              onChange={(event) => {
                update({ folder: event.target.value });
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
        <Field label={t('init.branch')} htmlFor={ids.branch}>
          <TextInput
            id={ids.branch}
            mono
            value={form.branch}
            invalid={touched && invalid === 'branch'}
            onChange={(event) => {
              branchEdited.current = true;
              update({ branch: event.target.value });
            }}
          />
        </Field>
        <fieldset className={styles.templates}>
          <legend className={styles.legend}>{t('init.gitignore')}</legend>
          <div className={styles.chips}>
            {TEMPLATES.map((template) => {
              const selected = form.gitignore.includes(template);
              return (
                <button
                  key={template}
                  type="button"
                  className={styles.chip}
                  aria-pressed={selected}
                  onClick={() => {
                    update({ gitignore: toggleTemplate(form.gitignore, template, TEMPLATES) });
                  }}
                >
                  {t(`init.template.${template}` as MessageKey)}
                </button>
              );
            })}
          </div>
          <p className={styles.hint}>{t('init.gitignore.hint')}</p>
        </fieldset>
        <Switch
          checked={form.readme}
          label={t('init.readme')}
          hint={t('init.readme.hint')}
          onCheckedChange={(readme) => {
            update({ readme });
          }}
        />
        {error && (
          <ErrorPanel
            compact
            title={t('init.failed')}
            error={error}
            context={{ retry: () => void submit() }}
          />
        )}
        <div className={styles.footer}>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {t('init.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
