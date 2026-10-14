import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { confirm } from '../../app/errors/confirmStore';
import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { modalOpen } from '../../app/shellActions';
import { useT } from '../../i18n/useT';
import {
  YagguiIpcError,
  type ConflictResolution,
  type YagguiError,
  type RepoOperation,
} from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Kbd } from '../../ui/Kbd';
import { matchShortcut } from '../../ui/shortcuts';
import { Spinner } from '../../ui/Spinner';
import { toast } from '../../ui/toastStore';
import { Tooltip } from '../../ui/Tooltip';
import { splitPath } from '../diff/fileTree';
import { ChoiceConflict } from './ChoiceConflict';
import { isTextConflict } from './choiceModel';
import { resolveConflicts, runMergeTool } from './conflictOps';
import { useConflictVersions, useMergeTool } from './conflictQueries';
import { conflictViewId, openConflictView, setConflictLeaveGuard } from './conflictViewStore';
import { useConflicts } from './useConflicts';
import { closeDiff } from '../diff/diffStore';
import type { MergeEditorHandle, SideTitle } from './MergeEditor';
import { MergeEditorLoader } from './MergeEditorLoader';
import {
  adjacentConflict,
  computeMerge,
  isResolved,
  withEol,
  type ConflictState,
  type Side,
} from './mergeModel';
import { sideCommit, sideNames, sideRole } from './sideLabels';
import styles from './ConflictView.module.css';

interface ConflictViewProps {
  tabId: string;
  repoId: number;
  path: string;
  operation: RepoOperation | null;
  /** Back to the graph (`Esc`). */
  onClose: () => void;
}

function asYagguiError(error: Error): YagguiError {
  return error instanceof YagguiIpcError
    ? error.error
    : {
        code: 'internal',
        message: { en: error.message, fr: error.message },
        action: null,
        detail: null,
        payload: null,
      };
}

/** Keys typed in a field (the result editor) or with a menu open are not view commands. */
function inField(event: KeyboardEvent): boolean {
  const target = event.target;
  return (
    target instanceof HTMLElement &&
    target.closest('input, textarea, [contenteditable="true"]') !== null
  );
}

/**
 * Resolution of one conflicted file in place of the graph (`conflict:<path>`, F-162 to F-165):
 * the 3-way editor for a text conflict, an explicit choice for a deletion or a binary file.
 */
export function ConflictView({ tabId, repoId, path, operation, onClose }: ConflictViewProps) {
  const t = useT();
  const query = useConflictVersions(repoId, path);
  const list = useConflicts(repoId, true).data;
  const tool = useMergeTool(repoId).data ?? null;
  const versions = query.data;
  const editor = useRef<MergeEditorHandle>(null);
  const [conflicts, setConflicts] = useState<readonly ConflictState[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const text = versions !== undefined && isTextConflict(versions);
  const model = useMemo(
    () =>
      versions && text
        ? computeMerge(
            versions.base?.text ?? '',
            versions.ours?.text ?? '',
            versions.theirs?.text ?? '',
          )
        : null,
    [versions, text],
  );
  // A new file starts with its first conflict selected (`MergeEditor` reveals it).
  const [shownModel, setShownModel] = useState(model);
  if (shownModel !== model) {
    setShownModel(model);
    setCurrent(model && model.conflicts.length > 0 ? 0 : null);
  }

  const labels = versions?.labels;
  const titles: Record<Side, SideTitle> | null = useMemo(() => {
    if (!labels) return null;
    const names = sideNames(labels, {
      ours: t('conflicts.mine'),
      theirs: t('conflicts.theirs'),
    });
    const title = (side: Side): SideTitle => ({
      name: names[side],
      role: t(`conflicts.editor.role.${sideRole(operation, side)}`),
      commit: sideCommit(labels[side]),
    });
    return { ours: title('ours'), theirs: title('theirs') };
  }, [labels, operation, t]);

  const files = list?.files ?? [];
  const unresolvedFiles = files.filter((f) => !f.resolved);
  const index = files.findIndex((f) => f.path === path);
  const remaining = conflicts.filter((c) => !isResolved(c)).length;
  const total = model?.conflicts.length ?? 0;

  /** Opens another file without asking: called once this one is resolved. */
  const open = (next: string) => {
    void openConflictView(tabId, { repoId, path: next }, { force: true });
  };

  // Choices and edits live in the editor only until saved: leaving asks first, whether by
  // the back button, `Esc` or "Resolve…" on another file of the conflicts panel.
  const dirty = model !== null && conflicts.some((c) => c.edited || c.choice.length > 0);
  const confirmLeave = useCallback(
    () =>
      confirm({
        title: t('conflicts.editor.leave.title'),
        description: t('conflicts.editor.leave.description'),
        confirmLabel: t('conflicts.editor.leave.confirm'),
        danger: true,
      }),
    [t],
  );
  useEffect(() => {
    setConflictLeaveGuard(tabId, dirty ? confirmLeave : null);
    return () => {
      setConflictLeaveGuard(tabId, null);
    };
  }, [tabId, dirty, confirmLeave]);
  const close = () => {
    void (async () => {
      if (!dirty || (await confirmLeave())) onClose();
    })();
  };

  // The editor replaces the graph like a diff does: one or the other.
  useEffect(() => {
    closeDiff(tabId);
  }, [tabId]);

  /** After a resolution: the next unresolved file, or back to the graph when none is left. */
  const afterResolve = () => {
    const next =
      unresolvedFiles.find((f) => f.path !== path && files.indexOf(f) > index) ??
      unresolvedFiles.find((f) => f.path !== path);
    if (next) {
      open(next.path);
      return;
    }
    toast({
      variant: 'success',
      title: t('conflicts.editor.allResolved'),
      description: t('conflicts.editor.allResolvedHint'),
    });
    onClose();
  };

  const resolve = async (resolution: ConflictResolution) => {
    if (busy) return;
    setBusy(true);
    const ok = await resolveConflicts(repoId, [path], resolution);
    setBusy(false);
    if (ok) afterResolve();
  };

  const save = () => {
    if (!model || remaining > 0 || !editor.current) return;
    void resolve({ kind: 'content', content: withEol(editor.current.text(), model.eol) });
  };

  const navigate = (direction: 1 | -1) => {
    const next = adjacentConflict(total, current, direction);
    if (next === null) return;
    setCurrent(next);
    editor.current?.reveal(next);
  };

  const external = async () => {
    if (!tool || busy) return;
    setBusy(true);
    const resolved = await runMergeTool(repoId, path, tool);
    setBusy(false);
    if (resolved) afterResolve();
    else void query.refetch();
  };

  // Kept in a ref so the window listener always sees the current state.
  const keys = useRef({ navigate, save, close });
  useEffect(() => {
    keys.current = { navigate, save, close };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (modalOpen()) return;
      if (matchShortcut(event, 'Alt+ArrowDown') || matchShortcut(event, 'Alt+ArrowUp')) {
        keys.current.navigate(event.key === 'ArrowDown' ? 1 : -1);
      } else if (matchShortcut(event, 'Mod+S')) {
        keys.current.save();
      } else if (matchShortcut(event, 'Escape') && !event.defaultPrevented && !inField(event)) {
        keys.current.close();
      } else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const { dir, name } = splitPath(path);
  const toolButton = text && (
    <Tooltip
      content={tool ? t('conflicts.editor.tool.open', { tool }) : t('conflicts.editor.tool.none')}
    >
      {/* A span, so the explanation shows on the disabled button too. */}
      <span className={styles.tooltipTarget} tabIndex={tool ? -1 : 0}>
        <Button size="sm" variant="ghost" disabled={!tool || busy} onClick={() => void external()}>
          <Icon name="settings" />
          {tool
            ? t('conflicts.editor.tool.button', { tool })
            : t('conflicts.editor.tool.buttonNone')}
        </Button>
      </span>
    </Tooltip>
  );

  let body;
  if (query.error) {
    body = (
      <div className={styles.centered}>
        <ErrorPanel
          title={t('conflicts.editor.failed')}
          error={asYagguiError(query.error)}
          context={{ retry: () => void query.refetch() }}
        />
      </div>
    );
  } else if (!versions || !titles) {
    body = (
      <div className={styles.centered} role="status">
        <Spinner />
      </div>
    );
  } else if (versions.kind === null) {
    body = (
      <div className={styles.centered}>
        <div className={styles.done} role="status">
          <Icon name="check" size="lg" />
          <p className={styles.doneTitle}>{t('conflicts.editor.notInConflict')}</p>
          {unresolvedFiles.length > 0 ? (
            <Button
              variant="primary"
              onClick={() => {
                const first = unresolvedFiles[0];
                if (first) open(first.path);
              }}
            >
              {t('conflicts.editor.nextFile')}
            </Button>
          ) : (
            <Button onClick={onClose}>{t('diff.back')}</Button>
          )}
        </div>
      </div>
    );
  } else if (model) {
    body = (
      <MergeEditorLoader
        model={model}
        path={path}
        titles={titles}
        onChange={setConflicts}
        ref={editor}
      />
    );
  } else {
    body = (
      <ChoiceConflict
        repoId={repoId}
        versions={versions}
        titles={titles}
        busy={busy}
        onResolve={(resolution) => void resolve(resolution)}
      />
    );
  }

  return (
    <section
      className={styles.view}
      aria-label={t('conflicts.view.label', { path })}
      data-view={conflictViewId(path)}
    >
      <div className={styles.toolbar}>
        <Button size="sm" variant="ghost" className={styles.back} onClick={close}>
          <Icon name="back" />
          {t('diff.back')}
          <Kbd shortcut="Escape" className={styles.backKey} />
        </Button>
        <span className={styles.badge}>{t('conflicts.editor.badge')}</span>
        <span className={styles.path} title={path}>
          <span className={styles.dir}>{dir}</span>
          {name}
        </span>
        {files.length > 1 && index >= 0 && (
          <span className={styles.position}>
            {t('conflicts.editor.filePosition', { index: index + 1, total: files.length })}
          </span>
        )}
        <span className={styles.spacer} />
        {model && total > 0 && (
          <>
            <span className={styles.counter} role="status" data-done={remaining === 0}>
              {remaining === 0
                ? t('conflicts.editor.noneLeft')
                : t('conflicts.editor.remaining', { count: remaining })}
            </span>
            <IconButton
              icon="chevronUp"
              size="sm"
              label={t('conflicts.editor.previous')}
              shortcut="Alt+ArrowUp"
              onClick={() => {
                navigate(-1);
              }}
            />
            <IconButton
              icon="chevronDown"
              size="sm"
              label={t('conflicts.editor.next')}
              shortcut="Alt+ArrowDown"
              onClick={() => {
                navigate(1);
              }}
            />
          </>
        )}
        {toolButton}
        {model && (
          <Tooltip
            content={
              remaining > 0
                ? t('conflicts.editor.saveBlocked', { count: remaining })
                : t('conflicts.editor.save')
            }
            shortcut="Mod+S"
          >
            <span className={styles.tooltipTarget} tabIndex={remaining > 0 ? 0 : -1}>
              <Button size="sm" variant="primary" disabled={remaining > 0 || busy} onClick={save}>
                <Icon name="check" />
                {t('conflicts.editor.save')}
              </Button>
            </span>
          </Tooltip>
        )}
      </div>
      {body}
    </section>
  );
}
