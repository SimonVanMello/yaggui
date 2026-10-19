import { createElement, type ComponentProps } from 'react';

import { Spinner } from '../../ui/Spinner';
import type { FileEditor } from './FileEditor';
import { useFileEditor } from './fileEditorModule';
import styles from './DiffView.module.css';

/** `FileEditor` once its chunk (CodeMirror) is loaded; a spinner before. */
export function FileEditorLoader(props: ComponentProps<typeof FileEditor>) {
  const component = useFileEditor();
  if (!component) {
    return (
      <div className={styles.centered} role="status">
        <Spinner />
      </div>
    );
  }
  return createElement(component, props);
}
