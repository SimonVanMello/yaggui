import { useEffect, useMemo, useRef } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { modalOpen } from '../../app/shellActions';
import type { MessageKey } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { YagguiIpcError, type YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { Spinner } from '../../ui/Spinner';
import { shortSha } from '../diff/format';
import { workingBranch } from '../repo/repoStatus';
import { useRepoState } from '../repo/useRepoState';
import { BasePicker } from './BasePicker';
import { CommitList } from './CommitList';
import styles from './InteractiveRebaseView.module.css';
import { rowsMatchPlan } from './rebaseLayout';
import { useAutosquashPlan } from './fixupOps';
import {
  initialRows,
  isFixupSummary,
  isUnchanged,
  preview,
  rowsFromTodo,
  validate,
} from './rebaseModel';
import { leaveRebase, refreshAfterRebase, useRebasePlan } from './rebaseOps';
import { openAutosquash, setRebaseRows, type RebaseSession } from './rebaseStore';
import { ResultPanel } from './ResultPanel';
import { StoppedPanel } from './StoppedPanel';
import { useRebaseRun } from './useRebaseRun';

function internal(message: string): YagguiError {
  return {
    code: 'internal',
    message: { en: message, fr: message },
    action: null,
    detail: null,
    payload: null,
  };
}

const KEYS: readonly { keys: readonly string[]; label: MessageKey }[] = [
  { keys: ['↑', '↓'], label: 'rebaseInteractive.hint.focus' },
  { keys: ['Alt+↑', 'Alt+↓'], label: 'rebaseInteractive.hint.move' },
  { keys: ['P', 'R', 'S', 'F', 'D', 'E'], label: 'rebaseInteractive.hint.actions' },
  { keys: ['Enter'], label: 'rebaseInteractive.hint.message' },
  { keys: ['Escape'], label: 'rebaseInteractive.hint.cancel' },
];

/**
 * Interactive rebase (F-142): replaces the graph in the center of the tab. The user orders
 * the commits, picks an action for each, edits messages, checks the result on the side and
 * starts the rebase; if it halts, the same view says where and how to go on.
 */
export function InteractiveRebaseView({
  tabId,
  repoId,
  session,
}: {
  tabId: string;
  repoId: number;
  session: RebaseSession;
}) {
  const t = useT();
  const { base, rows, stop, autosquash } = session;
  const state = useRepoState(repoId).data;
  const run = useRebaseRun(repoId, tabId);
  // Stopped, the rebase can also go on or end from elsewhere (the operation banner, a
  // terminal): once it is seen in progress then no longer, the view has nothing left to do.
  const sawOperation = useRef(false);
  const rebasing = state?.operation?.kind === 'rebase';
  useEffect(() => {
    if (stop === null) {
      sawOperation.current = false;
      return;
    }
    if (rebasing) sawOperation.current = true;
    else if (sawOperation.current && run.busy === null && state) {
      leaveRebase(repoId);
      refreshAfterRebase(repoId);
    }
  }, [stop, rebasing, run.busy, state, repoId]);
  const planQuery = useRebasePlan(repoId, base, stop === null && !autosquash);
  // Autosquash (F-147): the plan comes with its todo already arranged.
  const autosquashQuery = useAutosquashPlan(repoId, base, stop === null && autosquash);
  const arranged = autosquash ? autosquashQuery.data : undefined;
  const source = autosquash ? autosquashQuery : planQuery;
  const plan = autosquash ? arranged?.plan : planQuery.data;
  const refetching = source.isFetching;
  const unmatched = useMemo(() => new Set(arranged?.unmatched ?? []), [arranged]);
  const hasFixups = plan?.commits.some((commit) => isFixupSummary(commit.summary)) ?? false;

  // The todo starts as the plan (or its arrangement); a reloaded plan that no longer fits
  // replaces it.
  useEffect(() => {
    if (!plan || refetching) return;
    if (rows === null || !rowsMatchPlan(rows, plan)) {
      setRebaseRows(repoId, arranged ? rowsFromTodo(plan, arranged.todo) : initialRows(plan));
    }
  }, [plan, arranged, refetching, rows, repoId]);

  const result = useMemo(() => (rows ? preview(rows) : null), [rows]);
  const validation = useMemo(() => (rows ? validate(rows) : null), [rows]);
  const unchanged = rows && plan ? isUnchanged(rows, plan) : true;
  const branch = plan?.branch ?? (state ? workingBranch(state) : null) ?? '';
  const busy = run.busy !== null;
  const blocked = plan?.hasMerges === true || !validation?.ok || unchanged || busy;

  const close = () => {
    leaveRebase(repoId);
  };
  const reload = () => {
    run.clearError();
    setRebaseRows(repoId, null);
    void source.refetch();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || busy) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea')) return;
      if (modalOpen()) return;
      event.preventDefault();
      leaveRebase(repoId);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [repoId, busy]);

  let body;
  if (stop) {
    body = (
      <StoppedPanel
        repoId={repoId}
        stop={stop}
        busy={run.busy}
        error={run.error}
        onContinue={() => void run.goOn('continue', branch)}
        onSkip={() => void run.goOn('skip', branch)}
        onAbort={() => void run.abort(branch)}
        onClose={close}
      />
    );
  } else if (base === null && !autosquash) {
    body = <BasePicker repoId={repoId} />;
  } else if (autosquash && autosquashQuery.data === null) {
    body = (
      <div className={styles.centered}>
        <p className={styles.notice}>{t('fixup.nothingToSquash')}</p>
      </div>
    );
  } else if (source.error) {
    const error =
      source.error instanceof YagguiIpcError ? source.error.error : internal(source.error.message);
    body = (
      <div className={styles.centered}>
        <ErrorPanel
          title={t('rebaseInteractive.loadFailed')}
          error={error}
          context={{ retry: reload }}
        >
          <Button variant="ghost" onClick={close}>
            {t('common.close')}
          </Button>
        </ErrorPanel>
      </div>
    );
  } else if (!plan || !rows || !result) {
    body = (
      <div className={styles.centered} role="status">
        <Spinner />
        {t('rebaseInteractive.loading')}
      </div>
    );
  } else if (plan.commits.length === 0) {
    body = (
      <div className={styles.centered}>
        <p className={styles.notice}>{t('rebaseInteractive.empty')}</p>
      </div>
    );
  } else if (plan.hasMerges) {
    body = (
      <div className={styles.centered}>
        <p className={styles.notice} role="alert">
          <Icon name="warning" size="md" />
          {t('rebaseInteractive.hasMerges')}
        </p>
      </div>
    );
  } else {
    body = (
      <>
        {run.error && (
          <div className={styles.error}>
            <ErrorPanel compact title={t('rebaseInteractive.failed')} error={run.error}>
              <Button size="sm" onClick={reload}>
                <Icon name="retry" />
                {t('rebaseInteractive.reload')}
              </Button>
            </ErrorPanel>
          </div>
        )}
        {validation?.allDropped && (
          <p className={styles.warning} role="status">
            {t('rebaseInteractive.issue.allDropped')}
          </p>
        )}
        <div className={styles.content}>
          <CommitList
            rows={rows}
            onRows={(next) => {
              setRebaseRows(repoId, next);
            }}
            upstream={plan.upstream}
            unmatched={unmatched}
            label={t('rebaseInteractive.list')}
          />
          <ResultPanel plan={plan} rows={rows} result={result} />
        </div>
        <footer className={styles.hints}>
          {KEYS.map(({ keys, label }) => (
            <span key={label} className={styles.hint}>
              <span className={styles.keys}>
                {keys.map((key) => (
                  <Kbd key={key} shortcut={key} />
                ))}
              </span>
              {t(label)}
            </span>
          ))}
        </footer>
      </>
    );
  }

  const hint =
    !plan || stop || plan.hasMerges
      ? null
      : unchanged
        ? t('rebaseInteractive.startHint.unchanged')
        : validation?.ok === false
          ? t('rebaseInteractive.startHint.invalid')
          : null;

  return (
    <section className={styles.view} aria-label={t('rebaseInteractive.title')}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <h2 className={styles.title}>
            {stop ? t('rebaseInteractive.inProgress') : t('rebaseInteractive.title')}
          </h2>
          {branch && (
            <span className={styles.branch}>
              <Icon name="branch" />
              {branch}
            </span>
          )}
          {plan && !stop && (
            <span className={styles.meta} title={plan.base.summary}>
              {t('rebaseInteractive.onto', {
                sha: shortSha(plan.base.sha),
                summary: plan.base.summary,
              })}
            </span>
          )}
          {plan && !stop && (
            <span className={styles.meta}>
              {t('rebaseInteractive.commits', { count: plan.commits.length })}
            </span>
          )}
          {arranged && !stop && arranged.fixups > 0 && (
            <span className={styles.meta}>
              {t('rebaseInteractive.autosquashed', { count: arranged.fixups })}
            </span>
          )}
        </div>
        <div className={styles.buttons}>
          {hint && <span className={styles.startHint}>{hint}</span>}
          {!stop && (
            <>
              <Button variant="ghost" disabled={busy} onClick={close}>
                {t('common.cancel')}
                <Kbd shortcut="Escape" />
              </Button>
              {plan && hasFixups && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  title={t('rebaseInteractive.autosquashHint')}
                  onClick={() => {
                    run.clearError();
                    openAutosquash(repoId, plan.base.sha);
                  }}
                >
                  <Icon name="merge" />
                  {t('fixup.autosquash')}
                </Button>
              )}
              {(base !== null || autosquash) && (
                <Button
                  variant="primary"
                  aria-disabled={blocked}
                  onClick={() => {
                    if (!blocked && plan && rows) void run.start(plan, rows);
                  }}
                >
                  {run.busy === 'start' && <Spinner />}
                  {t('rebaseInteractive.start')}
                </Button>
              )}
            </>
          )}
        </div>
      </header>
      {body}
    </section>
  );
}
