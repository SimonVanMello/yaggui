import { useQuery } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';

import { queryClient } from '../../app/queryClient';
import { localize, showError } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { YagguiIpcError, ipc, unwrap, type CommitTemplate, type YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { IconButton } from '../../ui/IconButton';
import { TextInput } from '../../ui/TextInput';
import { useCommitDrafts } from './commitDraft';
import styles from './CommitToolsDialogs.module.css';
import { commitToolsKeys } from './commitToolsOps';
import { useCommitTools } from './commitToolsStore';

const EMPTY: CommitTemplate = { id: null, name: '', body: '' };

/** The user's commit message templates (F-067): add, edit, delete. Stored by yaggui. */
export function TemplatesDialog({ repoId }: { repoId: number | null }) {
  const t = useT();
  const close = useCommitTools((s) => s.close);
  const templates = useQuery({
    queryKey: commitToolsKeys.templates(),
    queryFn: () => unwrap(ipc.commands.listCommitTemplates()),
  });
  const [editing, setEditing] = useState<CommitTemplate>(EMPTY);
  const [error, setError] = useState<YagguiError | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: commitToolsKeys.templates() });
  const canSave = editing.name.trim() !== '' && editing.body.trim() !== '' && !busy;

  const save = (event: SubmitEvent) => {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    void unwrap(ipc.commands.saveCommitTemplate(editing))
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
    void unwrap(ipc.commands.deleteCommitTemplate(id))
      .then(() => {
        if (editing.id === id) setEditing(EMPTY);
        void refresh();
      })
      .catch(showError);
  };

  const fromDraft = () => {
    if (repoId === null) return;
    const draft = useCommitDrafts.getState().drafts[repoId];
    if (!draft) return;
    const body = draft.description.trim()
      ? `${draft.summary}\n\n${draft.description}`
      : draft.summary;
    setEditing((current) => ({ ...current, body }));
  };

  const list = templates.data ?? [];
  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('templates.title')}
      description={t('templates.description')}
      footer={
        <Button variant="ghost" onClick={close}>
          {t('common.close')}
        </Button>
      }
    >
      <div className={styles.body}>
        {list.length === 0 ? (
          <p className={styles.empty}>{t('templates.empty')}</p>
        ) : (
          <ul className={styles.list} aria-label={t('templates.title')}>
            {list.map((template) => (
              <li
                key={template.id ?? template.name}
                className={styles.item}
                data-editing={editing.id !== null && editing.id === template.id}
              >
                <span className={styles.itemText}>
                  <span className={styles.itemTitle}>{template.name}</span>
                  <span className={styles.itemHint}>{template.body.split('\n', 1)[0]}</span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(template);
                    setError(null);
                  }}
                >
                  {t('templates.edit')}
                </Button>
                {template.id !== null && (
                  <IconButton
                    size="sm"
                    icon="trash"
                    label={t('templates.delete', { name: template.name })}
                    onClick={() => {
                      if (template.id !== null) remove(template.id);
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        <form className={styles.form} onSubmit={save} aria-label={t('templates.form')}>
          <p className={styles.formTitle}>
            {editing.id === null ? t('templates.new') : t('templates.editing')}
          </p>
          <Field label={t('templates.name')} htmlFor="template-name">
            <TextInput
              id="template-name"
              value={editing.name}
              onChange={(event) => {
                setEditing({ ...editing, name: event.target.value });
                setError(null);
              }}
            />
          </Field>
          <Field label={t('templates.body')} htmlFor="template-body" hint={t('templates.bodyHint')}>
            <textarea
              id="template-body"
              className={styles.textarea}
              value={editing.body}
              spellCheck
              onChange={(event) => {
                setEditing({ ...editing, body: event.target.value });
                setError(null);
              }}
            />
          </Field>
          {error && (
            <p className={styles.error} role="alert">
              {localize(error.message)}
            </p>
          )}
          <div className={styles.formActions}>
            {repoId !== null && (
              <Button size="sm" variant="ghost" onClick={fromDraft}>
                {t('templates.fromDraft')}
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
            <Button size="sm" variant="primary" type="submit" aria-disabled={!canSave}>
              {editing.id === null ? t('templates.add') : t('templates.save')}
            </Button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
