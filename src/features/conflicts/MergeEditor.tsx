import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react';

import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import type { ConflictState, MergeModel, Side } from './mergeModel';
import { createMergeEditors, type MergeEditorLabels, type MergeEditors } from './mergeViews';
import styles from './MergeEditor.module.css';

export interface MergeEditorHandle {
  /** Scrolls to conflict `index` in the three panels. */
  reveal: (index: number) => void;
  /** Keeps one side for every conflict. */
  takeAll: (side: Side) => void;
  /** The result as edited (`\n` line breaks). */
  text: () => string;
}

export interface SideTitle {
  name: string;
  role: string;
  commit: string | null;
}

interface MergeEditorProps {
  model: MergeModel;
  path: string;
  titles: Record<Side, SideTitle>;
  onChange: (conflicts: readonly ConflictState[]) => void;
  ref?: Ref<MergeEditorHandle>;
}

function PanelTitle({ side, title }: { side: Side; title: SideTitle }) {
  return (
    <div className={styles.title} data-side={side}>
      <span className={styles.dot} aria-hidden />
      <strong className={styles.name}>{title.name}</strong>
      <span className={styles.role}>{title.role}</span>
      {title.commit && <span className={styles.commit}>{title.commit}</span>}
    </div>
  );
}

/**
 * 3-way merge editor (F-162): our and their versions on top, a checkbox per conflict, the
 * editable result below. CodeMirror lives in this lazily loaded module.
 */
export function MergeEditor({ model, path, titles, onChange, ref }: MergeEditorProps) {
  const t = useT();
  const oursRef = useRef<HTMLDivElement>(null);
  const theirsRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const editors = useRef<MergeEditors | null>(null);
  const change = useRef(onChange);
  useEffect(() => {
    change.current = onChange;
  });

  const names = useRef(titles);
  useEffect(() => {
    names.current = titles;
  });

  useLayoutEffect(() => {
    const [ours, theirs, result] = [oursRef.current, theirsRef.current, resultRef.current];
    if (!ours || !theirs || !result) return;
    const labels: MergeEditorLabels = {
      conflict: (n) => t('conflicts.editor.block', { n, total: model.conflicts.length }),
      take: (n, side) => t('conflicts.editor.take', { n, name: names.current[side].name }),
      unresolved: t('conflicts.editor.unresolvedBlock'),
      ours: names.current.ours.name,
      theirs: names.current.theirs.name,
      result: t('conflicts.editor.result'),
    };
    const created = createMergeEditors({
      model,
      parents: { ours, theirs, result },
      labels,
      onChange: (conflicts) => {
        change.current(conflicts);
      },
    });
    editors.current = created;
    void created.highlight(path);
    change.current(model.conflicts.map(() => ({ choice: [], edited: false })));
    if (model.conflicts.length > 0) created.reveal(0);
    return () => {
      created.destroy();
      editors.current = null;
    };
  }, [model, path, t]);

  const takeAll = (side: Side) => {
    model.conflicts.forEach((_, index) => editors.current?.choose(index, [side]));
  };

  useImperativeHandle(ref, () => ({
    reveal: (index) => editors.current?.reveal(index),
    takeAll,
    text: () => editors.current?.text() ?? '',
  }));

  return (
    <div className={styles.editor}>
      <div className={styles.top}>
        <section className={styles.panel} aria-label={titles.ours.name}>
          <PanelTitle side="ours" title={titles.ours} />
          <div ref={oursRef} className={styles.code} />
        </section>
        <section className={styles.panel} aria-label={titles.theirs.name}>
          <PanelTitle side="theirs" title={titles.theirs} />
          <div ref={theirsRef} className={styles.code} />
        </section>
      </div>
      <section className={styles.bottom} aria-label={t('conflicts.editor.result')}>
        <div className={styles.title} data-side="result">
          <strong className={styles.name}>{t('conflicts.editor.result')}</strong>
          <span className={styles.hint}>{t('conflicts.editor.resultHint')}</span>
          <span className={styles.spacer} />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              takeAll('ours');
            }}
          >
            {t('conflicts.editor.takeAll', { name: titles.ours.name })}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              takeAll('theirs');
            }}
          >
            {t('conflicts.editor.takeAll', { name: titles.theirs.name })}
          </Button>
        </div>
        <div ref={resultRef} className={styles.code} />
      </section>
    </div>
  );
}
