import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';

import { useT } from '../../i18n/useT';
import { ipc, unwrap } from '../../ipc';
import styles from './CommitTools.module.css';
import { useCommitDraft, useCommitDrafts } from './commitDraft';
import { commitToolsKeys } from './commitToolsOps';
import {
  CONVENTIONAL_TYPES,
  parseConventional,
  recentScopes,
  subjectLength,
  withHeader,
} from './conventional';

/** Subject length from which the helper warns (half of the summary limit, common practice). */
export const SUBJECT_LIMIT = 50;

/**
 * Type, scope and breaking-change fields that write the `type(scope)!:` header of the summary
 * (F-067). Scopes are suggested from the recent messages.
 */
export function ConventionalFields({ repoId }: { repoId: number }) {
  const t = useT();
  const listId = useId();
  const draft = useCommitDraft(repoId);
  const recent = useQuery({
    queryKey: commitToolsKeys.recent(repoId),
    queryFn: () => unwrap(ipc.commands.recentCommitMessages(repoId)),
  });
  const parsed = parseConventional(draft.summary);
  const scopes = recentScopes((recent.data ?? []).map((m) => m.message));
  const types: readonly string[] =
    parsed && !CONVENTIONAL_TYPES.some((type) => type === parsed.type)
      ? [parsed.type, ...CONVENTIONAL_TYPES]
      : CONVENTIONAL_TYPES;
  const update = (change: Parameters<typeof withHeader>[1]) => {
    useCommitDrafts.getState().update(repoId, { summary: withHeader(draft.summary, change) });
  };
  const subject = subjectLength(draft.summary);

  return (
    <div className={styles.conventional} role="group" aria-label={t('commit.conventional.label')}>
      <select
        className={styles.select}
        aria-label={t('commit.conventional.type')}
        value={parsed?.type ?? ''}
        onChange={(event) => {
          update({ type: event.target.value });
        }}
      >
        {!parsed && <option value="">{t('commit.conventional.pickType')}</option>}
        {types.map((type) => (
          <option key={type} value={type}>
            {type}
          </option>
        ))}
      </select>
      <input
        className={styles.scope}
        aria-label={t('commit.conventional.scope')}
        placeholder={t('commit.conventional.scope')}
        list={listId}
        value={parsed?.scope ?? ''}
        disabled={!parsed}
        spellCheck={false}
        onChange={(event) => {
          update({ scope: event.target.value.replace(/[()\n]/g, '') });
        }}
      />
      <datalist id={listId}>
        {scopes.map((scope) => (
          <option key={scope} value={scope} />
        ))}
      </datalist>
      <label className={styles.breaking}>
        <input
          type="checkbox"
          checked={parsed?.breaking ?? false}
          disabled={!parsed}
          onChange={(event) => {
            update({ breaking: event.target.checked });
          }}
        />
        {t('commit.conventional.breaking')}
      </label>
      <span
        className={styles.subject}
        data-level={subject > SUBJECT_LIMIT ? 'over' : 'ok'}
        title={t('commit.conventional.subjectHint', { limit: SUBJECT_LIMIT })}
      >
        {t('commit.conventional.subject', { count: subject, limit: SUBJECT_LIMIT })}
      </span>
    </div>
  );
}
