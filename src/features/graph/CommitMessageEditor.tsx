import { useState } from 'react';

import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { rewordCommit } from '../history/historyOps';
import { SUMMARY_LIMIT, summaryLength, summaryLevel } from '../staging/commitDraft';
import styles from './CommitMessageEditor.module.css';
import { joinMessage, rewordBlock, type RewordDraft } from './rewordDraft';

interface Props {
  repoId: number;
  sha: string;
  original: RewordDraft;
  /** The commit is HEAD: amended instead of rebased. */
  head: boolean;
  /** Another operation runs on the repository: saving waits for it to end. */
  busy: boolean;
  onCancel: () => void;
  /** The commit was reworded; `sha` is its new SHA. */
  onDone: (sha: string) => void;
}

/** Inline form of the commit detail header: same operation as `RewordDialog`. */
export function CommitMessageEditor({
  repoId,
  sha,
  original,
  head,
  busy,
  onCancel,
  onDone,
}: Props) {
  const t = useT();
  const [draft, setDraft] = useState(original);
  const [saving, setSaving] = useState(false);
  const block = rewordBlock(draft, original);
  const disabled = busy || saving || block !== null;
  const level = summaryLevel(draft.summary);

  const submit = () => {
    if (disabled) return;
    setSaving(true);
    void rewordCommit(repoId, sha, joinMessage(draft)).then((reworded) => {
      // On failure the draft stays, to retry or copy it.
      if (reworded === null) setSaving(false);
      else onDone(reworded);
    });
  };

  return (
    <div
      className={styles.editor}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          // The graph would also collapse its selection.
          event.stopPropagation();
          if (!saving) onCancel();
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          submit();
        }
      }}
    >
      <div className={styles.summary}>
        <input
          className={styles.input}
          value={draft.summary}
          placeholder={t('changes.summaryPlaceholder')}
          aria-label={t('changes.summaryPlaceholder')}
          aria-invalid={block === 'empty' || undefined}
          readOnly={saving}
          spellCheck
          autoFocus
          onChange={(event) => {
            setDraft({ ...draft, summary: event.target.value });
          }}
        />
        <span
          className={styles.counter}
          data-level={level}
          title={
            level === 'over' ? t('commit.summaryTooLong', { limit: SUMMARY_LIMIT }) : undefined
          }
        >
          {summaryLength(draft.summary)}/{SUMMARY_LIMIT}
        </span>
      </div>
      <textarea
        className={styles.description}
        value={draft.description}
        rows={4}
        placeholder={t('commit.descriptionPlaceholder')}
        aria-label={t('commit.descriptionPlaceholder')}
        readOnly={saving}
        spellCheck
        onChange={(event) => {
          setDraft({ ...draft, description: event.target.value });
        }}
      />
      <p className={styles.note} data-tone={head ? undefined : 'warning'}>
        <Icon name={head ? 'info' : 'warning'} size="sm" />
        <span>{t(head ? 'history.reword.headText' : 'history.reword.rebaseText')}</span>
      </p>
      <div className={styles.actions}>
        <Button variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" size="sm" aria-disabled={disabled} onClick={submit}>
          {saving ? t('graph.detail.rewording') : t('history.reword.confirm')}
          <Kbd shortcut="Mod+Enter" />
        </Button>
      </div>
    </div>
  );
}
