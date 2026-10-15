import { createElement, type ComponentProps } from 'react';

import { Spinner } from '../../../ui/Spinner';
import styles from '../DiffView.module.css';
import type { MarkdownDiff } from './MarkdownDiff';
import { useMarkdownDiff } from './markdownDiffModule';

/** `MarkdownDiff` once its chunk (the Markdown parser) is loaded; a spinner before. */
export function MarkdownDiffLoader(props: ComponentProps<typeof MarkdownDiff>) {
  const component = useMarkdownDiff();
  if (!component) {
    return (
      <div className={styles.centered} role="status">
        <Spinner />
      </div>
    );
  }
  return createElement(component, props);
}
