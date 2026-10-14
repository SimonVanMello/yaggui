import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { formatRelativeTime } from '../../i18n/relativeTime';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { YagguiIpcError } from '../../ipc';
import { Spinner } from '../../ui/Spinner';
import { useNow } from '../../ui/useNow';
import { shortSha } from '../diff/format';
import styles from './BasePicker.module.css';
import { useBaseCandidates } from './rebaseOps';
import { chooseRebaseBase } from './rebaseStore';

/** Choice of the commit to rebase on top of, among the latest commits of the branch. */
export function BasePicker({ repoId }: { repoId: number }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const now = useNow();
  const query = useBaseCandidates(repoId);
  const [focus, setFocus] = useState(0);
  const candidates = query.data ?? [];
  const listRef = useRef<HTMLUListElement>(null);
  const ready = candidates.length > 0;
  useEffect(() => {
    if (ready) listRef.current?.focus();
  }, [ready]);

  if (query.isPending) {
    return (
      <div className={styles.centered} role="status">
        <Spinner />
        {t('rebaseInteractive.loading')}
      </div>
    );
  }
  if (query.error) {
    const error =
      query.error instanceof YagguiIpcError
        ? query.error.error
        : {
            code: 'internal' as const,
            message: { en: query.error.message, fr: query.error.message },
            action: null,
            detail: null,
            payload: null,
          };
    return (
      <div className={styles.centered}>
        <ErrorPanel
          title={t('rebaseInteractive.loadFailed')}
          error={error}
          context={{ retry: () => void query.refetch() }}
        />
      </div>
    );
  }
  if (candidates.length === 0) {
    return (
      <div className={styles.centered}>
        <p className={styles.empty}>{t('rebaseInteractive.picker.empty')}</p>
      </div>
    );
  }

  const current = Math.min(focus, candidates.length - 1);
  const pick = (index: number) => {
    const candidate = candidates[index];
    if (candidate) chooseRebaseBase(repoId, candidate.sha);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setFocus(Math.max(0, Math.min(candidates.length - 1, current + step)));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(current);
    }
  };

  return (
    <div className={styles.picker}>
      <p className={styles.intro}>{t('rebaseInteractive.picker.intro')}</p>
      <ul
        className={styles.list}
        role="listbox"
        aria-label={t('rebaseInteractive.picker.label')}
        aria-activedescendant={`rebase-base-${String(current)}`}
        ref={listRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {candidates.map((candidate, index) => (
          <li
            key={candidate.sha}
            id={`rebase-base-${String(index)}`}
            role="option"
            aria-selected={index === current}
            data-focused={index === current}
            className={styles.option}
            onClick={() => {
              pick(index);
            }}
            onMouseMove={() => {
              if (index !== current) setFocus(index);
            }}
          >
            <span className={styles.sha}>{shortSha(candidate.sha)}</span>
            <span className={styles.summary} title={candidate.summary}>
              {candidate.summary}
            </span>
            <span className={styles.author}>{candidate.authorName}</span>
            <span className={styles.date}>
              {candidate.authorTime !== null &&
                formatRelativeTime(candidate.authorTime, now, locale)}
            </span>
            <span className={styles.count}>
              {t('rebaseInteractive.picker.above', { count: candidate.above })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
