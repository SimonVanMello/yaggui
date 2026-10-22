import { createElement, type ComponentProps } from 'react';

import { Spinner } from '../../ui/Spinner';
import type { FileViewer } from './FileViewer';
import { useFileViewer } from './fileViewerModule';
import styles from './TreeView.module.css';

/** `FileViewer` once its chunk (CodeMirror) is loaded; a spinner before. */
export function FileViewerLoader(props: ComponentProps<typeof FileViewer>) {
  const component = useFileViewer();
  if (!component) {
    return (
      <div className={styles.notice} role="status">
        <Spinner />
      </div>
    );
  }
  return createElement(component, props);
}
