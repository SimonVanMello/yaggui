import { createElement, type ComponentProps } from 'react';

import { Spinner } from '../../ui/Spinner';
import type { MergeEditor } from './MergeEditor';
import { useMergeEditor } from './mergeEditorModule';
import styles from './ConflictView.module.css';

/** `MergeEditor` once its chunk (CodeMirror) is loaded; a spinner before. */
export function MergeEditorLoader(props: ComponentProps<typeof MergeEditor>) {
  const component = useMergeEditor();
  if (!component) {
    return (
      <div className={styles.centered} role="status">
        <Spinner />
      </div>
    );
  }
  return createElement(component, props);
}
