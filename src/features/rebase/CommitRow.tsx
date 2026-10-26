import type { PointerEvent } from 'react';

import { formatRelativeTime } from '../../i18n/relativeTime';
import { useT } from '../../i18n/useT';
import type { Locale, RebaseAction } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { shortSha } from '../diff/format';
import { ActionButtons } from './ActionButtons';
import styles from './CommitRow.module.css';
import { MessageEditor } from './MessageEditor';
import { isAmend, isMelded, summaryOf, type RebaseRow, type RowIssue } from './rebaseModel';

export interface RowHandlers {
  onSelect: (index: number) => void;
  onAction: (index: number, action: RebaseAction) => void;
  onEdit: (index: number | null) => void;
  onMessage: (index: number, message: string | null) => void;
  onGripDown: (event: PointerEvent<HTMLElement>, index: number) => void;
  onGripMove: (event: PointerEvent<HTMLElement>) => void;
  onGripEnd: (event: PointerEvent<HTMLElement>, apply: boolean) => void;
}

interface CommitRowProps extends RowHandlers {
  id: string;
  row: RebaseRow;
  /** Index in todo order. */
  index: number;
  focused: boolean;
  dragging: boolean;
  /** The drop indicator is drawn above or below this row. */
  drop: 'before' | 'after' | null;
  issue: RowIssue | undefined;
  /** Summary of the commit this one melds into. */
  meldedInto: string | null;
  /** Another row melds into this one. */
  hasMelded: boolean;
  /** Final message of the commit when this row holds it (reword, last squash or fixup -C). */
  finalMessage: string | null;
  editing: boolean;
  upstream: string | null;
  /** A `fixup!` commit whose target is not in the list (autosquash): left as it is. */
  unmatched: boolean;
  now: number;
  locale: Locale;
}

/** One commit of the todo: grip, action, identity, and what the action does to it. */
export function CommitRow({
  id,
  row,
  index,
  focused,
  dragging,
  drop,
  issue,
  meldedInto,
  hasMelded,
  finalMessage,
  editing,
  upstream,
  unmatched,
  now,
  locale,
  onSelect,
  onAction,
  onEdit,
  onMessage,
  onGripDown,
  onGripMove,
  onGripEnd,
}: CommitRowProps) {
  const t = useT();
  const { commit, action } = row;
  const time = commit.authorTime;
  const sha = shortSha(commit.sha);
  // Only while it is still left as it is: moved or melded by hand, it is the user's call.
  const noTarget = unmatched && meldedInto === null && action !== 'edit';

  return (
    <li
      id={id}
      role="option"
      aria-selected={focused}
      aria-label={`${sha} ${commit.summary}`}
      className={styles.row}
      data-row=""
      data-index={index}
      data-action={action}
      data-focused={focused}
      data-melded={isMelded(action)}
      data-amend={isAmend(row) || undefined}
      data-has-melded={hasMelded}
      data-dragging={dragging}
      data-drop={drop ?? undefined}
      data-issue={issue}
      onClick={() => {
        onSelect(index);
      }}
    >
      <span
        className={styles.grip}
        aria-hidden="true"
        onPointerDown={(event) => {
          onGripDown(event, index);
        }}
        onPointerMove={onGripMove}
        onPointerUp={(event) => {
          onGripEnd(event, true);
        }}
        onPointerCancel={(event) => {
          onGripEnd(event, false);
        }}
        onLostPointerCapture={(event) => {
          onGripEnd(event, false);
        }}
      />
      <ActionButtons
        value={action}
        label={t('rebaseInteractive.actionOf', { sha })}
        onChange={(next) => {
          onAction(index, next);
        }}
      />
      <span className={styles.sha}>{sha}</span>
      <span className={styles.summary} title={commit.summary}>
        {commit.summary}
      </span>
      <span className={styles.author} title={commit.authorEmail}>
        {commit.authorName}
      </span>
      <span className={styles.date}>
        {time !== null && (
          <time dateTime={new Date(time * 1000).toISOString()}>
            {formatRelativeTime(time, now, locale)}
          </time>
        )}
      </span>
      <span className={styles.pushed}>
        {commit.pushed && (
          <span
            className={styles.pushedMark}
            title={upstream ? t('rebaseInteractive.pushedOn', { target: upstream }) : undefined}
          >
            <Icon name="cloud" />
            {t('rebaseInteractive.pushed')}
          </span>
        )}
      </span>

      {(meldedInto !== null || action === 'edit' || issue !== undefined || noTarget) && (
        <p className={styles.note} data-tone={issue || noTarget ? 'warning' : undefined}>
          {issue === 'noTarget' && t('rebaseInteractive.issue.noTarget')}
          {issue === 'emptyMessage' && t('rebaseInteractive.issue.emptyMessage')}
          {issue === undefined &&
            meldedInto !== null &&
            t(isAmend(row) ? 'rebaseInteractive.meldedIntoAmend' : 'rebaseInteractive.meldedInto', {
              summary: meldedInto,
            })}
          {issue === undefined && action === 'edit' && t('rebaseInteractive.stopsHere')}
          {issue === undefined && noTarget && t('rebaseInteractive.fixupNoTarget')}
        </p>
      )}

      {finalMessage !== null && !editing && (
        <div className={styles.message}>
          <span className={styles.messageLabel}>{t('rebaseInteractive.newMessage')}</span>
          <span className={styles.messageText} title={finalMessage}>
            {summaryOf(finalMessage) || t('rebaseInteractive.emptyMessage')}
          </span>
          <Button
            size="sm"
            variant="ghost"
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation();
              onEdit(index);
            }}
          >
            {t('rebaseInteractive.editMessage')}
          </Button>
        </div>
      )}
      {editing && finalMessage !== null && (
        <MessageEditor
          message={finalMessage}
          onChange={(message) => {
            onMessage(index, message);
          }}
          onReset={
            row.message === null
              ? null
              : () => {
                  onMessage(index, null);
                }
          }
          onClose={() => {
            onEdit(null);
          }}
        />
      )}
    </li>
  );
}
