import { useEffect, useRef, useState, type ReactNode } from 'react';

import { modalOpen } from '../../app/shellActions';
import { useT } from '../../i18n/useT';
import { YagguiIpcError } from '../../ipc';
import { matchShortcut } from '../../ui/shortcuts';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { ErrorPanel } from '../../app/errors/ErrorPanel';
import type { CodeDiffHandle } from './CodeDiff';
import { CodeDiffLoader } from './CodeDiffLoader';
import { adjacentFile } from './diffModel';
import { useChangedFiles, useFileDiff, useWorktreeDiffRefresh } from './diffQueries';
import {
  fileKey,
  forceRender,
  hunkOptions,
  setDiffOptions,
  toggleDiffView,
  useDiffOptions,
  useDiffStore,
  useDiffView,
  type DiffSelection,
} from './diffStore';
import { DiffNotices } from './DiffNotices';
import { emptyDiffReason } from './emptyDiff';
import { ExternalDiffButtons } from './ExternalDiffButtons';
import { ImageDiff } from './ImageDiff';
import { applyHunks } from '../staging/stagingActions';
import { openLineHistory } from '../inspect/inspectStore';
import { DiffPlaceholder } from './DiffPlaceholder';
import { ModuleDiffActions } from '../submodules/ModuleDiffActions';
import { DiffToolbar } from './DiffToolbar';
import { FileEditorLoader } from './FileEditorLoader';
import { startEditing, useEditing } from './fileEditStore';
import { isMarkdown } from './markdown/isMarkdown';
import { MarkdownPreview } from './markdown/MarkdownPreview';
import styles from './DiffView.module.css';

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i;

/** Keys typed in a text field or with a menu open are not diff commands. */
function ignoredTarget(event: KeyboardEvent): boolean {
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    target.closest(
      'input:not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"]',
    )
  ) {
    return true;
  }
  return modalOpen() || document.querySelector('[role="menu"][data-state="open"]') !== null;
}

interface DiffViewProps {
  selection: DiffSelection;
  /** Back to the graph (`Esc`). */
  onClose: () => void;
  /** Opens another file of the same target (`j` / `k`). */
  onSelect: (selection: DiffSelection) => void;
  /**
   * Replaces the file navigation (`j` / `k`, the arrows): the file history steps through its
   * commits instead.
   */
  stepper?: {
    onStep: (direction: 1 | -1) => void;
    canPrevious: boolean;
    canNext: boolean;
    position: { index: number; total: number } | null;
    labels: { previous: string; next: string };
  };
  /** Extra toolbar buttons. */
  actions?: ReactNode;
}

/** Diff of one file in place of the graph (spec §4): toolbar, notices, code. */
export function DiffView({ selection, onClose, onSelect, stepper, actions }: DiffViewProps) {
  const t = useT();
  const { repoId, target, path, oldPath } = selection;
  const view = useDiffView();
  const options = useDiffOptions();
  const markdown = isMarkdown(path);
  const preview = markdown && options.markdownPreview === true;
  const diffOptions = { ...hunkOptions(options), force: false };
  const force = useDiffStore((state) => state.forced[fileKey(selection)] === true);
  const code = useRef<CodeDiffHandle>(null);
  useWorktreeDiffRefresh(repoId);

  const filesQuery = useChangedFiles(repoId, target);
  const files = filesQuery.data?.files;
  const query = useFileDiff(repoId, target, path, oldPath, { ...diffOptions, force });
  const diff = query.data;
  // An SVG is text: shown as an image, its source one click away (path it was asked for).
  const [sourceOf, setSourceOf] = useState<string | null>(null);
  const index = files?.findIndex((f) => f.path === path) ?? -1;
  const file = index >= 0 ? files?.[index] : undefined;
  const previous = files ? adjacentFile(files, path, -1) : null;
  const next = files ? adjacentFile(files, path, 1) : null;

  const openFile = (direction: 1 | -1) => {
    if (stepper) {
      stepper.onStep(direction);
      return;
    }
    const target = direction === 1 ? next : previous;
    if (target) onSelect({ ...selection, path: target.path, oldPath: target.oldPath });
  };

  // Kept in a ref so the window listener always sees the current file list.
  const keys = useRef({ openFile, onClose, preview: false });
  useEffect(() => {
    keys.current = { openFile, onClose, preview };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || ignoredTarget(event)) return;
      const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
      if (matchShortcut(event, 'Escape')) {
        if (!code.current?.clearSelection()) keys.current.onClose();
      } else if (matchShortcut(event, 'Mod+D')) {
        if (keys.current.preview) setDiffOptions({ markdownPreview: false });
        else toggleDiffView();
      } else if (plain && (event.key === 'n' || event.key === 'p')) {
        code.current?.navigate(event.key === 'n' ? 1 : -1);
      } else if (plain && (event.key === 'j' || event.key === 'k')) {
        keys.current.openFile(event.key === 'j' ? 1 : -1);
      } else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  // A previous file stays on screen while the next one loads (no flash): show it only if
  // it is the one asked for.
  const current = diff && diff.path === path ? diff : undefined;
  const worktree = target.kind === 'commits' ? null : target.kind;

  // A working tree file left its list (discarded, staged, reverted outside the app): its diff
  // has nothing left to show, so it closes instead of reporting the backend's "no changes".
  const gone = worktree !== null && files !== undefined && index < 0;
  useEffect(() => {
    if (gone) keys.current.onClose();
  }, [gone]);

  // Plain UTF-8 text the editor can write back as it is (the backend checks it again).
  const editable =
    worktree === 'unstaged' &&
    current !== undefined &&
    (current.newMode === 'regular' || current.newMode === 'executable') &&
    current.content.kind === 'text' &&
    current.content.newEncoding === 'utf8' &&
    current.content.newLineEnding !== 'mixed';
  const editing = useEditing(repoId, path) && worktree === 'unstaged';

  const isImage = IMAGE.test(path);
  const placeholder = current ? (
    <DiffPlaceholder
      content={current.content}
      isImage={isImage}
      empty={emptyDiffReason(current, options.ignoreWhitespace)}
      onShowWhitespace={
        options.ignoreWhitespace
          ? () => {
              setDiffOptions({ ignoreWhitespace: false });
            }
          : undefined
      }
      onForce={() => {
        forceRender(selection);
      }}
      actions={
        <ModuleDiffActions repoId={repoId} target={target} path={path} content={current.content} />
      }
    />
  ) : null;

  let body;
  if (editing && (editable || !current)) {
    body = <FileEditorLoader key={path} repoId={repoId} path={path} wrap={options.wrap} />;
  } else if (gone || (worktree !== null && query.error && filesQuery.isFetching)) {
    // Closing, or the list is being read again and may show the file gone: no error flash.
    body = null;
  } else if (query.error) {
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
    body = (
      <div className={styles.centered}>
        <ErrorPanel
          title={t('diff.failed')}
          error={error}
          context={{ retry: () => void query.refetch() }}
        />
      </div>
    );
  } else if (!current) {
    body = (
      <div className={styles.centered} role="status">
        <Spinner />
      </div>
    );
  } else if (
    isImage &&
    sourceOf !== path &&
    (current.content.kind === 'binary' ||
      current.content.kind === 'tooLarge' ||
      current.content.kind === 'text')
  ) {
    const { content } = current;
    const sizes =
      content.kind === 'binary' || content.kind === 'tooLarge'
        ? { old: content.oldSize, new: content.newSize }
        : { old: null, new: null };
    body = (
      <ImageDiff
        key={`${path}\u0000${oldPath ?? ''}`}
        repoId={repoId}
        target={target}
        path={path}
        oldPath={oldPath}
        oldSize={sizes.old}
        newSize={sizes.new}
        fallback={placeholder}
        actions={
          content.kind === 'text' ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSourceOf(path);
              }}
            >
              {t('diff.image.showSource')}
            </Button>
          ) : undefined
        }
      />
    );
  } else if (preview && current.content.kind === 'text' && current.content.hunks.length > 0) {
    body = (
      <MarkdownPreview
        ref={code}
        repoId={repoId}
        target={target}
        path={path}
        oldPath={oldPath}
        force={force}
        onForce={() => {
          forceRender(selection);
        }}
      />
    );
  } else if (current.content.kind === 'text' && current.content.hunks.length > 0) {
    body = (
      <CodeDiffLoader
        ref={code}
        diff={current.content}
        view={view}
        path={path}
        worktree={worktree}
        wrap={options.wrap}
        resetKey={JSON.stringify(hunkOptions(options))}
        actionsDisabled={
          options.ignoreWhitespace
            ? t('diff.hunk.whitespaceOn')
            : query.isPlaceholderData
              ? t('diff.hunk.loading')
              : null
        }
        onLineHistory={
          target.kind === 'commits'
            ? (span) => {
                openLineHistory(repoId, { path, rev: target.to, ...span });
              }
            : undefined
        }
        onHunks={
          worktree
            ? (action, hunks, lineCount) => {
                void applyHunks({
                  repoId,
                  action,
                  diff: current,
                  options: { ...diffOptions, force },
                  hunks,
                  lineCount,
                });
              }
            : undefined
        }
      />
    );
  } else {
    body = placeholder;
  }

  return (
    <section className={styles.diff} aria-label={t('diff.label', { path })}>
      <DiffToolbar
        path={path}
        oldPath={oldPath}
        file={file}
        view={view}
        markdown={markdown}
        preview={preview}
        position={
          stepper ? stepper.position : files && index >= 0 ? { index, total: files.length } : null
        }
        onBack={onClose}
        onFile={openFile}
        canPrevious={stepper ? stepper.canPrevious : previous !== null}
        canNext={stepper ? stepper.canNext : next !== null}
        stepLabels={stepper?.labels}
        actions={
          <>
            {editable && !editing && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  startEditing(repoId, path);
                }}
              >
                <Icon name="pencil" size="sm" />
                {t('diff.edit.button')}
              </Button>
            )}
            {isImage && sourceOf === path && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSourceOf(null);
                }}
              >
                {t('diff.image.showImage')}
              </Button>
            )}
            <ExternalDiffButtons
              repoId={repoId}
              target={target}
              path={path}
              oldPath={oldPath}
              deleted={file?.status === 'deleted'}
            />
            {actions}
          </>
        }
      />
      {current && (
        <DiffNotices
          diff={current}
          similarity={file?.similarity ?? null}
          whitespaceIgnored={options.ignoreWhitespace}
        />
      )}
      {body}
    </section>
  );
}
