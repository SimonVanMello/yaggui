import { useEffect, useRef, useState } from 'react';

import { useT } from '../../i18n/useT';
import type { CommitSearch } from '../../ipc';
import { IconButton } from '../../ui/IconButton';
import { Spinner } from '../../ui/Spinner';
import type { GraphSource, SearchState } from './graphSource';
import styles from './GraphSearchBar.module.css';

function toEpoch(value: string, endOfDay: boolean): number | null {
  if (!value) return null;
  const ms = Date.parse(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}`);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function fromEpoch(value: number | null): string {
  if (value === null) return '';
  return new Date(value * 1000).toLocaleDateString('sv-SE');
}

/** Search bar of the graph (F-027): text, author, path and date range; `↵` / `⇧↵` to step. */
export function GraphSearchBar({ source, state }: { source: GraphSource; state: SearchState }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [advanced, setAdvanced] = useState(false);
  const { query, matches, active, running, error } = state;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const update = (patch: Partial<CommitSearch>) => {
    source.setQuery({ ...query, ...patch });
  };
  const hasQuery = Object.values(query).some((v) => v !== null && v !== '');

  const counter = (() => {
    if (error) return t('graph.search.error');
    if (!hasQuery) return '';
    if (matches.length === 0) return running ? t('graph.search.searching') : t('graph.search.none');
    const position = active >= 0 ? active + 1 : 0;
    return t('graph.search.count', { index: position, count: matches.length });
  })();

  return (
    <div className={styles.bar} role="search" aria-label={t('graph.search.label')}>
      <div className={styles.line}>
        <input
          ref={input}
          className={styles.input}
          value={query.text ?? ''}
          placeholder={t('graph.search.placeholder')}
          aria-label={t('graph.search.label')}
          onChange={(event) => {
            update({ text: event.target.value });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              source.stepMatch(event.shiftKey ? -1 : 1);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              source.closeSearch();
            }
          }}
        />
        {running && <Spinner />}
        <span className={styles.counter} aria-live="polite">
          {counter}
        </span>
        <IconButton
          icon="chevronUp"
          label={t('graph.search.previous')}
          disabled={matches.length === 0}
          onClick={() => {
            source.stepMatch(-1);
          }}
        />
        <IconButton
          icon="chevronDown"
          label={t('graph.search.next')}
          disabled={matches.length === 0}
          onClick={() => {
            source.stepMatch(1);
          }}
        />
        <IconButton
          icon={advanced ? 'chevronUp' : 'more'}
          label={t('graph.search.filters')}
          onClick={() => {
            setAdvanced(!advanced);
          }}
        />
        <IconButton
          icon="close"
          label={t('common.close')}
          onClick={() => {
            source.closeSearch();
          }}
        />
      </div>
      {advanced && (
        <div className={styles.filters}>
          <label className={styles.field}>
            <span>{t('graph.search.author')}</span>
            <input
              value={query.author ?? ''}
              onChange={(event) => {
                update({ author: event.target.value });
              }}
            />
          </label>
          <label className={styles.field}>
            <span>{t('graph.search.path')}</span>
            <input
              value={query.path ?? ''}
              placeholder="src/app"
              onChange={(event) => {
                update({ path: event.target.value });
              }}
            />
          </label>
          <label className={styles.field}>
            <span>{t('graph.search.since')}</span>
            <input
              type="date"
              value={fromEpoch(query.since)}
              onChange={(event) => {
                update({ since: toEpoch(event.target.value, false) });
              }}
            />
          </label>
          <label className={styles.field}>
            <span>{t('graph.search.until')}</span>
            <input
              type="date"
              value={fromEpoch(query.until)}
              onChange={(event) => {
                update({ until: toEpoch(event.target.value, true) });
              }}
            />
          </label>
        </div>
      )}
    </div>
  );
}
