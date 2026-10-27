import { useVirtualizer } from '@tanstack/react-virtual';
import { useId, useMemo, useRef, useState, type SyntheticEvent } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useT } from '../../i18n/useT';
import {
  YagguiIpcError,
  ipc,
  SCAN_DEPTH_MAX,
  SCAN_DEPTH_MIN,
  unwrap,
  type YagguiError,
  type ScanProgress,
  type ScanResult,
} from '../../ipc';
import { useYagguiEvent } from '../../ipc/useYagguiEvent';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { ProgressBar } from '../../ui/ProgressBar';
import { Spinner } from '../../ui/Spinner';
import { TextInput } from '../../ui/TextInput';
import { toast } from '../../ui/toastStore';
import styles from './ScanDialog.module.css';
import { createWorkspace, importRepos, pickFolder } from './workspaceOps';
import { useWorkspaces } from './workspaceQueries';
import { useWorkspaceUi } from './workspaceStore';

const DEFAULT_DEPTH = 3;
const ROW_HEIGHT = 40;
/** `<select>` value of "create a new workspace". */
const NEW_WORKSPACE = 'new';
const NO_WORKSPACE = 'none';

let scanCounter = 0;

function newScanId(): string {
  scanCounter += 1;
  return `scan-${String(Date.now())}-${String(scanCounter)}`;
}

/** "Scan a folder" (F-007): find the repositories under a folder and import a selection. */
export function ScanDialog() {
  const scan = useWorkspaceUi((state) => state.scan);
  return scan ? <ScanFlow workspaceId={scan.workspaceId} /> : null;
}

type Phase =
  | { step: 'form' }
  | { step: 'running'; scanId: string; progress: ScanProgress | null; cancelling: boolean }
  | { step: 'results'; result: ScanResult };

function ScanFlow({ workspaceId }: { workspaceId: number | null }) {
  const t = useT();
  const ids = { root: useId(), depth: useId(), target: useId(), name: useId() };
  const [root, setRoot] = useState('');
  const [depth, setDepth] = useState(String(DEFAULT_DEPTH));
  const [phase, setPhase] = useState<Phase>({ step: 'form' });
  const [error, setError] = useState<YagguiError | null>(null);
  const [touched, setTouched] = useState(false);

  const close = () => {
    useWorkspaceUi.getState().closeScan();
  };

  useYagguiEvent('scanProgress', (progress) => {
    setPhase((current) =>
      current.step === 'running' && current.scanId === progress.scanId
        ? { ...current, progress }
        : current,
    );
  });

  const depthValue = Number(depth);
  const depthValid =
    Number.isInteger(depthValue) && depthValue >= SCAN_DEPTH_MIN && depthValue <= SCAN_DEPTH_MAX;
  const rootValid = root.trim() !== '';

  const start = async (event?: SyntheticEvent) => {
    event?.preventDefault();
    setTouched(true);
    if (!rootValid || !depthValid || phase.step === 'running') return;
    const scanId = newScanId();
    setError(null);
    setPhase({ step: 'running', scanId, progress: null, cancelling: false });
    try {
      const result = await unwrap(
        ipc.commands.scanFolder({ scanId, root: root.trim(), maxDepth: depthValue }),
      );
      setPhase({ step: 'results', result });
    } catch (failure) {
      setPhase({ step: 'form' });
      if (failure instanceof YagguiIpcError) {
        if (failure.error.code !== 'cancelled') setError(failure.error);
      } else {
        console.error(failure);
      }
    }
  };

  const cancel = () => {
    if (phase.step !== 'running' || phase.cancelling) return;
    setPhase({ ...phase, cancelling: true });
    void ipc.commands.cancelScan(phase.scanId);
  };

  const browse = async () => {
    const picked = await pickFolder('scan.pickerTitle');
    if (picked) {
      setRoot(picked);
      setError(null);
    }
  };

  let content;
  if (phase.step === 'running') {
    const progress = phase.progress;
    content = (
      <div className={styles.progress}>
        <ProgressBar percent={null} label={t('scan.running')} />
        <div className={styles.phase} aria-live="polite">
          <span>
            {phase.cancelling && <Spinner />}{' '}
            {phase.cancelling
              ? t('scan.cancelling')
              : t('scan.found', { count: progress?.found ?? 0 })}
          </span>
          <span>{t('scan.visited', { count: progress?.visited ?? 0 })}</span>
        </div>
        <div className={styles.current}>{progress?.current ?? root}</div>
        <div className={styles.footer}>
          <Button variant="danger" disabled={phase.cancelling} onClick={cancel}>
            {t('scan.cancel')}
          </Button>
        </div>
      </div>
    );
  } else if (phase.step === 'results') {
    content = (
      <ScanResults
        result={phase.result}
        defaultWorkspaceId={workspaceId}
        onBack={() => {
          setPhase({ step: 'form' });
        }}
        onDone={close}
      />
    );
  } else {
    content = (
      <form
        className={styles.form}
        onSubmit={(event) => {
          void start(event);
        }}
      >
        <div className={styles.pair}>
          <Field label={t('scan.root')} htmlFor={ids.root}>
            <div className={styles.row}>
              <TextInput
                id={ids.root}
                mono
                autoFocus
                value={root}
                placeholder={t('scan.root.placeholder')}
                invalid={touched && !rootValid}
                onChange={(event) => {
                  setRoot(event.target.value);
                  setError(null);
                }}
              />
              <Button
                onClick={() => {
                  void browse();
                }}
              >
                {t('clone.browse')}
              </Button>
            </div>
          </Field>
          <Field
            label={t('scan.depth')}
            htmlFor={ids.depth}
            hint={
              touched && !depthValid
                ? t('scan.depth.invalid', { min: SCAN_DEPTH_MIN, max: SCAN_DEPTH_MAX })
                : undefined
            }
          >
            <TextInput
              id={ids.depth}
              type="number"
              inputMode="numeric"
              min={SCAN_DEPTH_MIN}
              max={SCAN_DEPTH_MAX}
              value={depth}
              invalid={touched && !depthValid}
              onChange={(event) => {
                setDepth(event.target.value);
              }}
            />
          </Field>
        </div>
        <p className={styles.hint}>{t('scan.hint')}</p>
        {error && (
          <ErrorPanel
            compact
            title={t('scan.failed')}
            error={error}
            context={{ retry: () => void start() }}
          />
        )}
        <div className={styles.footer}>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary">
            {t('scan.start')}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <Dialog
      open
      wide
      onOpenChange={(next) => {
        // A running scan is stopped with its own button, never by a stray Escape.
        if (!next && phase.step !== 'running') close();
      }}
      title={t('scan.title')}
      description={phase.step === 'form' ? t('scan.description') : undefined}
    >
      {content}
    </Dialog>
  );
}

interface ScanResultsProps {
  result: ScanResult;
  defaultWorkspaceId: number | null;
  onBack: () => void;
  onDone: () => void;
}

function ScanResults({ result, defaultWorkspaceId, onBack, onDone }: ScanResultsProps) {
  const t = useT();
  const targetId = useId();
  const nameId = useId();
  const workspaces = useWorkspaces().data ?? [];
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(result.repos.map((repo) => repo.path)),
  );
  const [target, setTarget] = useState(
    defaultWorkspaceId === null ? NO_WORKSPACE : String(defaultWorkspaceId),
  );
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const repos = result.repos;
  const newCount = useMemo(() => repos.filter((repo) => repo.knownId === null).length, [repos]);

  const virtualizer = useVirtualizer({
    count: repos.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => repos[index]?.path ?? index,
    overscan: 8,
  });

  const toggle = (path: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const allSelected = selected.size === repos.length;
  const needsName = target === NEW_WORKSPACE && newName.trim() === '';

  const submit = async () => {
    if (selected.size === 0 || needsName || busy) return;
    setBusy(true);
    try {
      const existingId =
        target === NEW_WORKSPACE || target === NO_WORKSPACE ? null : Number(target);
      const paths = repos.filter((repo) => selected.has(repo.path)).map((repo) => repo.path);
      const imported = await importRepos(paths, existingId);
      if (!imported) return;
      let workspaceId = existingId;
      if (target === NEW_WORKSPACE) {
        // Created after the import, from the imported ids: a failed import leaves no empty
        // workspace behind, and a retry does not create a second one with the same name.
        const created = await createWorkspace(newName, imported);
        if (!created) return;
        workspaceId = created.id;
      }
      toast({ variant: 'success', title: t('scan.imported', { count: imported.length }) });
      onDone();
      if (workspaceId !== null) useWorkspaceUi.getState().openManager(workspaceId);
    } finally {
      setBusy(false);
    }
  };

  if (repos.length === 0) {
    return (
      <div className={styles.form}>
        <div className={styles.empty}>{t('scan.none', { count: result.visited })}</div>
        <div className={styles.footer}>
          <Button variant="ghost" onClick={onBack}>
            {t('scan.again')}
          </Button>
          <Button variant="primary" onClick={onDone}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.form}>
      <div className={styles.summary}>
        <span>
          {t('scan.summary', { count: repos.length, fresh: newCount })}
          {result.truncated && ` ${t('scan.truncated')}`}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setSelected(allSelected ? new Set() : new Set(repos.map((repo) => repo.path)));
          }}
        >
          {allSelected ? t('scan.selectNone') : t('scan.selectAll')}
        </Button>
      </div>
      <div ref={scrollRef} className={styles.results}>
        <div
          role="group"
          aria-label={t('scan.results')}
          className={styles.list}
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const repo = repos[item.index];
            if (!repo) return null;
            return (
              <label
                key={item.key}
                className={styles.result}
                style={{ height: ROW_HEIGHT, transform: `translateY(${String(item.start)}px)` }}
              >
                <input
                  type="checkbox"
                  className={styles.check}
                  checked={selected.has(repo.path)}
                  onChange={() => {
                    toggle(repo.path);
                  }}
                />
                <span className={styles.resultText}>
                  <span className={styles.resultName}>{repo.name}</span>
                  <span className={styles.resultPath}>{repo.path}</span>
                </span>
                {repo.knownId !== null && <span className={styles.known}>{t('scan.known')}</span>}
              </label>
            );
          })}
        </div>
      </div>
      <div className={styles.pair}>
        <Field label={t('scan.target')} htmlFor={targetId}>
          <select
            id={targetId}
            className={styles.select}
            value={target}
            onChange={(event) => {
              setTarget(event.target.value);
            }}
          >
            <option value={NO_WORKSPACE}>{t('scan.target.none')}</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={String(workspace.id)}>
                {workspace.name}
              </option>
            ))}
            <option value={NEW_WORKSPACE}>{t('scan.target.new')}</option>
          </select>
        </Field>
        {target === NEW_WORKSPACE && (
          <Field label={t('scan.target.name')} htmlFor={nameId}>
            <TextInput
              id={nameId}
              autoFocus
              value={newName}
              placeholder={t('workspace.name.placeholder')}
              onChange={(event) => {
                setNewName(event.target.value);
              }}
            />
          </Field>
        )}
      </div>
      <div className={styles.footer}>
        <Button variant="ghost" onClick={onBack}>
          {t('scan.again')}
        </Button>
        <Button
          variant="primary"
          disabled={selected.size === 0 || needsName || busy}
          onClick={() => {
            void submit();
          }}
        >
          {t('scan.import', { count: selected.size })}
        </Button>
      </div>
    </div>
  );
}
