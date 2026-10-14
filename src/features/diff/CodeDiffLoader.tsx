import { createElement, type ComponentProps } from 'react';

import { Spinner } from '../../ui/Spinner';
import type { CodeDiff } from './CodeDiff';
import { useCodeDiff } from './codeDiffModule';
import styles from './DiffView.module.css';

/** `CodeDiff` once its chunk (CodeMirror) is loaded; a spinner for the first diff only. */
export function CodeDiffLoader(props: ComponentProps<typeof CodeDiff>) {
  const component = useCodeDiff();
  if (!component) {
    return (
      <div className={styles.centered} role="status">
        <Spinner />
      </div>
    );
  }
  return createElement(component, props);
}
