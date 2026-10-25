import { useState, type ReactNode } from 'react';

import { useI18nStore } from '../../i18n/i18n';
import { formatRelativeTime } from '../../i18n/relativeTime';
import { useT } from '../../i18n/useT';
import type { BisectCommit, BisectMark } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { useNow } from '../../ui/useNow';
import { shortOid } from '../repo/repoStatus';
import bannerStyles from '../repo/RepoBanners.module.css';
import { bisectNext, endBisect, markBisect, showBisectCommit } from './bisectOps';
import { bisectPhase, canMarkCurrent } from './bisectModel';
import { useBisectState } from './useBisectState';
import styles from './BisectBanner.module.css';

/** Candidates of an inconclusive bisect listed in the banner; the rest is counted. */
const LISTED_CANDIDATES = 5;

const MARKS: readonly BisectMark[] = ['good', 'bad', 'skip'];

function CommitLink({
  repoId,
  commit,
  withSummary,
}: {
  repoId: number;
  commit: BisectCommit;
  withSummary: boolean;
}) {
  return (
    <button
      type="button"
      className={styles.commit}
      title={`${commit.sha}\n${commit.summary}`}
      onClick={() => {
        showBisectCommit(repoId, commit.sha);
      }}
    >
      <code>{shortOid(commit.sha)}</code>
      {withSummary && <span className={styles.summary}>{commit.summary}</span>}
    </button>
  );
}

/**
 * Banner of a bisect in progress (F-263), in place of the generic operation banner: the
 * commit under test and the estimated steps left, good / bad / skip for it, then the first
 * bad commit with a jump to it. Ending the bisect resets HEAD to where it started.
 */
export function BisectBanner({ repoId }: { repoId: number }) {
  const t = useT();
  const locale = useI18nStore((s) => s.locale);
  const now = useNow();
  const state = useBisectState(repoId).data;
  const [busy, setBusy] = useState(false);
  const runWork = (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void work().finally(() => {
      setBusy(false);
    });
  };

  const phase = state ? bisectPhase(state) : null;
  const done = phase?.kind === 'found' || phase?.kind === 'inconclusive';
  const tone =
    phase?.kind === 'found' ? 'success' : phase?.kind === 'inconclusive' ? 'warning' : 'info';

  let title: string = t('bisect.title');
  let body: ReactNode = null;
  switch (phase?.kind) {
    case 'needBad':
      body = <span className={bannerStyles.muted}>{t('bisect.needBad')}</span>;
      break;
    case 'needGood':
      body = <span className={bannerStyles.muted}>{t('bisect.needGood')}</span>;
      break;
    case 'awaitingCheckout':
      body = <span className={bannerStyles.muted}>{t('bisect.awaitingCheckout')}</span>;
      break;
    case 'testing':
      body = (
        <>
          {phase.current && (
            <span>
              {t('bisect.testing')}
              <CommitLink repoId={repoId} commit={phase.current} withSummary />
            </span>
          )}
          <span className={bannerStyles.muted} data-testid="bisect-steps">
            {t('bisect.steps', { count: phase.steps })}
            {' · '}
            {t('bisect.commitsLeft', { count: phase.remaining })}
          </span>
        </>
      );
      break;
    case 'found': {
      title = t('bisect.found.title');
      const { commit } = phase;
      body = (
        <>
          <CommitLink repoId={repoId} commit={commit} withSummary />
          <span className={bannerStyles.muted}>
            {commit.authorTime === null
              ? commit.authorName
              : t('bisect.found.by', {
                  author: commit.authorName,
                  date: formatRelativeTime(commit.authorTime, now, locale),
                })}
          </span>
        </>
      );
      break;
    }
    case 'inconclusive': {
      title = t('bisect.inconclusive.title');
      const { candidates } = phase;
      const more = candidates.length - LISTED_CANDIDATES;
      body = (
        <span className={styles.candidates}>
          <span className={bannerStyles.muted}>
            {t('bisect.inconclusive.text', { count: candidates.length })}
          </span>
          {candidates.slice(0, LISTED_CANDIDATES).map((c) => (
            <CommitLink key={c.sha} repoId={repoId} commit={c} withSummary={false} />
          ))}
          {more > 0 && (
            <span className={bannerStyles.muted}>{t('bisect.more', { count: more })}</span>
          )}
        </span>
      );
      break;
    }
    case undefined:
      break;
  }

  return (
    <div
      className={bannerStyles.banner}
      data-tone={tone}
      role="status"
      aria-label={t('bisect.label')}
      data-testid="bisect-banner"
    >
      <Icon
        name={phase?.kind === 'found' ? 'check' : 'search'}
        size="md"
        className={bannerStyles.icon}
      />
      <span className={bannerStyles.text}>
        <b>{title}</b>
        {state?.firstParent && (
          <span
            className={styles.mode}
            title={t('bisect.firstParent.hint')}
            data-testid="bisect-first-parent"
          >
            <Icon name="firstParent" />
            {t('bisect.firstParent')}
          </span>
        )}
        {body}
      </span>
      <span className={bannerStyles.actions}>
        {phase &&
          canMarkCurrent(phase) &&
          MARKS.map((mark) => (
            <Button
              key={mark}
              size="sm"
              variant="secondary"
              aria-disabled={busy}
              title={t(`bisect.mark.${mark}Hint`)}
              onClick={() => {
                runWork(() => markBisect(repoId, null, mark));
              }}
            >
              <span className={styles.dot} data-mark={mark} aria-hidden />
              {t(`bisect.mark.${mark}`)}
            </Button>
          ))}
        {phase?.kind === 'awaitingCheckout' && (
          <Button
            size="sm"
            variant="primary"
            aria-disabled={busy}
            onClick={() => {
              runWork(() => bisectNext(repoId));
            }}
          >
            {t('bisect.next')}
          </Button>
        )}
        {phase?.kind === 'found' && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              showBisectCommit(repoId, phase.commit.sha);
            }}
          >
            {t('bisect.showCommit')}
          </Button>
        )}
        <Button
          size="sm"
          variant={done ? 'primary' : 'danger'}
          aria-disabled={busy}
          onClick={() => {
            runWork(() => endBisect(repoId));
          }}
        >
          {t(done ? 'bisect.end' : 'operation.bisect.abort')}
        </Button>
      </span>
    </div>
  );
}
