import { useState } from 'react';

import { confirm } from '../../app/errors/confirmStore';
import { useT } from '../../i18n/useT';
import type { ConflictFile, ConflictKind, ConflictLabels } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Tooltip } from '../../ui/Tooltip';
import { resolveConflicts } from './conflictOps';
import { hasUnsavedConflictEdits, openConflictView } from './conflictViewStore';
import styles from './ConflictsPanel.module.css';
import { useConflicts } from './useConflicts';

function sideName(label: ConflictLabels['ours'], fallback: string): string {
  return label.branch ?? (label.commit ? label.commit.sha.slice(0, 7) : fallback);
}

function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/');
  return slash < 0
    ? { dir: '', name: path }
    : { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

const KIND_KEYS = {
  content: 'conflicts.kind.content',
  bothAdded: 'conflicts.kind.bothAdded',
  deletedByUs: 'conflicts.kind.deletedByUs',
  deletedByThem: 'conflicts.kind.deletedByThem',
  addedByUs: 'conflicts.kind.addedByUs',
  addedByThem: 'conflicts.kind.addedByThem',
  bothDeleted: 'conflicts.kind.bothDeleted',
} as const satisfies Record<ConflictKind, string>;

function ConflictRow({
  repoId,
  tabId,
  file,
  ours,
  theirs,
}: {
  repoId: number;
  tabId: string;
  file: ConflictFile;
  ours: string;
  theirs: string;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const { dir, name } = splitPath(file.path);
  const run = (resolution: Parameters<typeof resolveConflicts>[2]) => {
    if (busy) return;
    setBusy(true);
    void (async () => {
      try {
        // The file is open in the editor with unsaved choices: this would throw them away.
        if (
          hasUnsavedConflictEdits(tabId, { repoId, path: file.path }) &&
          !(await confirm({
            title: t('conflicts.editor.leave.title'),
            description: t('conflicts.quick.unsavedDescription'),
            confirmLabel: t('conflicts.editor.leave.confirm'),
            danger: true,
          }))
        ) {
          return;
        }
        await resolveConflicts(repoId, [file.path], resolution);
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <li className={styles.row} data-resolved={file.resolved || undefined}>
      <div className={styles.head}>
        <Icon
          name={file.resolved ? 'check' : 'warning'}
          className={file.resolved ? styles.resolvedIcon : styles.conflictIcon}
          aria-label={t(
            file.resolved ? 'conflicts.status.resolved' : 'conflicts.status.unresolved',
          )}
        />
        <span className={styles.path} title={file.path}>
          <span className={styles.dir}>{dir}</span>
          <span className={styles.name}>{name}</span>
        </span>
        {file.binary && <span className={styles.badge}>{t('conflicts.binary')}</span>}
      </div>
      <div className={styles.detail}>
        {file.resolved
          ? t('conflicts.status.resolved')
          : file.kind
            ? t(KIND_KEYS[file.kind], { ours, theirs })
            : t('conflicts.status.unresolved')}
      </div>
      {!file.resolved && (
        <div className={styles.actions}>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              void openConflictView(tabId, { repoId, path: file.path });
            }}
          >
            {t('conflicts.resolve')}
          </Button>
          <Tooltip content={t('conflicts.takeTooltip', { side: ours })}>
            <Button
              size="sm"
              aria-disabled={busy}
              onClick={() => {
                run({ kind: 'ours' });
              }}
            >
              {t('conflicts.take', { side: ours })}
            </Button>
          </Tooltip>
          <Tooltip content={t('conflicts.takeTooltip', { side: theirs })}>
            <Button
              size="sm"
              aria-disabled={busy}
              onClick={() => {
                run({ kind: 'theirs' });
              }}
            >
              {t('conflicts.take', { side: theirs })}
            </Button>
          </Tooltip>
          <Button
            size="sm"
            variant="ghost"
            aria-disabled={busy}
            onClick={() => {
              run({ kind: 'markResolved' });
            }}
          >
            {t('conflicts.markResolved')}
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * Conflicted files of the operation in progress (F-160, F-161): counter, resolved / unresolved
 * status, type of conflict and the quick resolutions by branch name. "Resolve…" opens the
 * conflict editor (view `conflict:<path>`).
 */
export function ConflictsPanel({ repoId, tabId }: { repoId: number; tabId: string }) {
  const t = useT();
  const list = useConflicts(repoId, true).data;
  if (!list || list.files.length === 0) return null;
  const ours = sideName(list.labels.ours, t('conflicts.mine'));
  const theirs = sideName(list.labels.theirs, t('conflicts.theirs'));
  const total = list.files.length;

  return (
    <section className={styles.panel} aria-label={t('conflicts.title')}>
      <header className={styles.header}>
        <Icon name="warning" className={styles.conflictIcon} />
        <b>{t('conflicts.title')}</b>
        <span className={styles.counter} data-clear={list.unresolved === 0 || undefined}>
          {list.unresolved > 0
            ? t('conflicts.counter', { unresolved: list.unresolved, total })
            : t('conflicts.allResolved', { total })}
        </span>
      </header>
      <p className={styles.legend}>{t('conflicts.legend', { ours, theirs })}</p>
      <ul className={styles.list} aria-label={t('conflicts.title')}>
        {list.files.map((file) => (
          <ConflictRow
            key={file.path}
            repoId={repoId}
            tabId={tabId}
            file={file}
            ours={ours}
            theirs={theirs}
          />
        ))}
      </ul>
    </section>
  );
}
