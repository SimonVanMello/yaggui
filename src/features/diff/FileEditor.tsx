import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { confirm } from '../../app/errors/confirmStore';
import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { showYagguiError } from '../../app/errors/presentError';
import { queryClient } from '../../app/queryClient';
import { modalOpen } from '../../app/shellActions';
import { useT } from '../../i18n/useT';
import { ipc, YagguiIpcError, type WorktreeFile, type YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { matchShortcut } from '../../ui/shortcuts';
import { Spinner } from '../../ui/Spinner';
import { diffKeys, useWorktreeFile } from './diffQueries';
import {
  createFileEditor,
  type FileEditor as Editor,
  type FileEditorState,
} from './fileEditorView';
import { keepDraft, stopEditing, takeDraft } from './fileEditStore';
import styles from './FileEditor.module.css';

interface FileEditorProps {
  repoId: number;
  path: string;
  wrap: boolean;
}

/**
 * The working tree file of an unstaged diff, editable (Mod+S saves), with its changes since
 * the index version marked. Unsaved edits survive leaving the file (see `fileEditStore`).
 */
export function FileEditor({ repoId, path, wrap }: FileEditorProps) {
  const t = useT();
  const query = useWorktreeFile(repoId, path);
  const file = query.data;
  const loaded = file !== undefined;
  const parent = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  const [state, setState] = useState<FileEditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = state?.dirty === true;
  // Another program changed the file while there are unsaved edits: the user picks a side.
  const changed = file && state && dirty && file.version !== state.version ? file : null;

  // Created once per file, from its first load; later loads go through the effect below.
  useLayoutEffect(() => {
    const host = parent.current;
    const first = queryClient.getQueryData<WorktreeFile>(diffKeys.edit(repoId, path));
    if (!host || !first) return;
    const created = createFileEditor({
      parent: host,
      text: first.text,
      original: first.original,
      version: first.version,
      lineSeparator: first.lineEnding === 'crlf' ? '\r\n' : '\n',
      label: t('diff.edit.label', { path }),
      wrap: false,
      onState: (next) => {
        setState(next);
        if (next.dirty) setSaved(false);
      },
    });
    editor.current = created;
    const draft = takeDraft(repoId, path);
    if (draft) created.restore(draft.text, draft.version);
    void created.highlight(path);
    created.view.focus();
    return () => {
      const { dirty, version } = created.state();
      if (dirty) keepDraft(repoId, path, { text: created.text(), version });
      created.destroy();
      editor.current = null;
    };
  }, [repoId, path, loaded, t]);

  // Reloaded after a watcher event: an untouched editor follows the file.
  useEffect(() => {
    const current = editor.current;
    if (!current || !file) return;
    current.setOriginal(file.original);
    const { dirty, version } = current.state();
    if (!dirty && file.version !== version) current.load(file.text, file.version);
  }, [file]);

  useEffect(() => {
    editor.current?.setWrap(wrap);
  }, [wrap, loaded]);

  const save = async () => {
    const current = editor.current;
    if (!current || saving || changed) return;
    const { dirty, version } = current.state();
    if (!dirty) return;
    setSaving(true);
    const text = current.text();
    const result = await ipc.commands.saveWorktreeFile(repoId, path, text, version);
    setSaving(false);
    if (result.status === 'error') {
      if (result.error.code === 'fileChanged') void query.refetch();
      else showYagguiError(result.error, { title: t('diff.edit.saveFailed', { path }) });
      return;
    }
    // What is on disk now, before the watcher says so: no false "changed on disk".
    queryClient.setQueryData<WorktreeFile>(diffKeys.edit(repoId, path), (previous) =>
      previous ? { ...previous, text, version: result.data } : previous,
    );
    current.saved(text, result.data);
    if (!current.state().dirty) setSaved(true);
  };
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || modalOpen() || !matchShortcut(event, 'Mod+S')) return;
      event.preventDefault();
      void saveRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const done = async () => {
    const current = editor.current;
    if (current?.state().dirty) {
      const discard = await confirm({
        title: t('diff.edit.discardTitle'),
        description: t('diff.edit.discardDescription', { path }),
        confirmLabel: t('diff.edit.discard'),
        danger: true,
      });
      if (!discard) return;
      // Not kept as a draft when the editor closes.
      if (file) current.load(file.text, file.version);
    }
    stopEditing(repoId, path);
  };

  if (query.error) {
    const error: YagguiError =
      query.error instanceof YagguiIpcError
        ? query.error.error
        : {
            code: 'internal',
            message: { en: query.error.message, fr: query.error.message },
            action: null,
            detail: null,
            payload: null,
          };
    return (
      <div className={styles.centered}>
        <ErrorPanel title={t('diff.edit.loadFailed')} error={error}>
          <Button
            size="sm"
            onClick={() => {
              stopEditing(repoId, path);
            }}
          >
            {t('diff.edit.backToDiff')}
          </Button>
        </ErrorPanel>
      </div>
    );
  }

  return (
    <div className={styles.editor}>
      <div className={styles.bar} role="toolbar" aria-label={t('diff.edit.toolbar')}>
        <span className={styles.status} role="status">
          {dirty ? (
            <>
              <span className={styles.dot} aria-hidden="true" />
              {t('diff.edit.unsaved')}
            </>
          ) : saved ? (
            <>
              <Icon name="check" size="sm" />
              {t('diff.edit.saved')}
            </>
          ) : (
            t('diff.edit.hint')
          )}
        </span>
        <Button
          size="sm"
          variant="primary"
          aria-disabled={!dirty || saving || changed !== null}
          aria-keyshortcuts="Mod+S"
          onClick={() => void save()}
        >
          {t('diff.edit.save')}
          <Kbd shortcut="Mod+S" />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void done()}>
          {t('diff.edit.done')}
        </Button>
      </div>
      {changed && (
        <div className={styles.changed} role="alert">
          <Icon name="warning" size="sm" />
          <span className={styles.changedText}>{t('diff.edit.changedOnDisk', { path })}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              editor.current?.load(changed.text, changed.version);
            }}
          >
            {t('diff.edit.reload')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              editor.current?.rebase(changed.version);
            }}
          >
            {t('diff.edit.keepMine')}
          </Button>
        </div>
      )}
      {!loaded && (
        <div className={styles.centered} role="status">
          <Spinner />
        </div>
      )}
      <div ref={parent} className={styles.code} hidden={!loaded} />
    </div>
  );
}
