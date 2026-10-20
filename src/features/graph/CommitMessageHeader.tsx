import { useEffect, useRef, useState } from 'react';

import { useT } from '../../i18n/useT';
import type { CommitDetail } from '../../ipc';
import { IconButton } from '../../ui/IconButton';
import styles from './CommitDetailPanel.module.css';
import { CommitMessageEditor } from './CommitMessageEditor';
import { splitMessage } from './rewordDraft';

interface Props {
  repoId: number;
  commit: CommitDetail;
  /** Another operation runs on the repository: no rewrite can start. */
  busy: boolean;
  onReworded: (sha: string) => void;
}

/**
 * Message of the selected commit; the pencil, or a click on the text, turns it into a form
 * that changes it, like "Edit commit message…" in the graph's context menu.
 */
export function CommitMessageHeader({ repoId, commit, busy, onReworded }: Props) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const original = splitMessage(commit.message, commit.summary);
  const head = commit.refs.some((ref) => ref.isHead || ref.kind === 'head');

  useEffect(() => {
    if (!editing && returnFocus.current) {
      returnFocus.current = false;
      editButton.current?.focus();
    }
  }, [editing]);

  if (editing) {
    return (
      <header className={styles.header}>
        <CommitMessageEditor
          repoId={repoId}
          sha={commit.sha}
          original={original}
          head={head}
          busy={busy}
          onCancel={() => {
            returnFocus.current = true;
            setEditing(false);
          }}
          onDone={(sha) => {
            setEditing(false);
            onReworded(sha);
          }}
        />
      </header>
    );
  }

  return (
    <header className={styles.header} data-editable={!busy || undefined}>
      {/* Mouse shortcut for the pencil, which is the keyboard and screen reader way in. */}
      <div
        className={styles.message}
        onClick={() => {
          // Selecting text to copy it is not a request to edit.
          if (busy || (window.getSelection()?.toString() ?? '') !== '') return;
          setEditing(true);
        }}
      >
        <h2 className={styles.summary}>{commit.summary}</h2>
        {original.description && <p className={styles.body}>{original.description}</p>}
      </div>
      <IconButton
        ref={editButton}
        className={styles.edit}
        icon="pencil"
        size="sm"
        label={t('graph.detail.editMessage')}
        disabled={busy}
        onClick={() => {
          setEditing(true);
        }}
      />
    </header>
  );
}
