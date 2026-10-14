import { useRef, useState, type KeyboardEvent } from 'react';

import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { SUMMARY_LIMIT, summaryLength, summaryLevel } from '../staging/commitDraft';
import styles from './MessageEditor.module.css';
import { joinMessage, splitMessage } from './rebaseLayout';

interface MessageEditorProps {
  /** Message the commit has now. */
  message: string;
  /** Receives the full message (summary, blank line, description) on every keystroke. */
  onChange: (message: string) => void;
  /** Back to the default message of the row. */
  onReset: (() => void) | null;
  onClose: () => void;
}

/**
 * Message of a reworded commit or of a squash group, edited in the list. The text is kept in
 * the fields while typing: only the joined message goes to the model, which trims it.
 */
export function MessageEditor({ message, onChange, onReset, onClose }: MessageEditorProps) {
  const t = useT();
  const [fields, setFields] = useState(() => splitMessage(message));
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const level = summaryLevel(fields.summary);

  const update = (next: { summary: string; description: string }) => {
    setFields(next);
    onChange(joinMessage(next.summary, next.description));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div className={styles.editor} onKeyDown={onKeyDown}>
      <div className={styles.summary} data-level={level}>
        <input
          autoFocus
          className={styles.input}
          value={fields.summary}
          placeholder={t('changes.summaryPlaceholder')}
          aria-label={t('changes.summaryPlaceholder')}
          spellCheck
          onChange={(event) => {
            update({ ...fields, summary: event.target.value });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              descriptionRef.current?.focus();
            }
          }}
        />
        <span className={styles.counter} data-level={level}>
          {summaryLength(fields.summary)}/{SUMMARY_LIMIT}
        </span>
      </div>
      {level === 'over' && (
        <p className={styles.warning} role="status">
          {t('commit.summaryTooLong', { limit: SUMMARY_LIMIT })}
        </p>
      )}
      <textarea
        ref={descriptionRef}
        className={styles.description}
        value={fields.description}
        rows={3}
        placeholder={t('commit.descriptionPlaceholder')}
        aria-label={t('commit.descriptionPlaceholder')}
        onChange={(event) => {
          update({ ...fields, description: event.target.value });
        }}
      />
      <div className={styles.actions}>
        <span className={styles.note}>{t('rebaseInteractive.message.note')}</span>
        {onReset && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onReset();
              onClose();
            }}
          >
            {t('rebaseInteractive.message.reset')}
          </Button>
        )}
        <Button size="sm" onClick={onClose}>
          {t('rebaseInteractive.message.done')}
        </Button>
      </div>
    </div>
  );
}
