import { useEffect, useRef } from 'react';

import { createFileViewer, type FileViewer as Viewer } from './fileViewerView';
import styles from './FileViewer.module.css';

interface Props {
  path: string;
  text: string;
  label: string;
  wrap: boolean;
}

/** Read-only, highlighted text of a file (CodeMirror, loaded on first use). */
export function FileViewer({ path, text, label, wrap }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const created = createFileViewer({ parent, label, wrap });
    viewer.current = created;
    return () => {
      created.destroy();
      viewer.current = null;
    };
    // Created once: the content and the wrapping go through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewer.current?.show(text, path);
  }, [text, path]);

  useEffect(() => {
    viewer.current?.setWrap(wrap);
  }, [wrap]);

  return <div ref={host} className={styles.viewer} />;
}
