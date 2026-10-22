import { useEffect, useState } from 'react';

type FileViewerModule = typeof import('./FileViewer');

let loaded: FileViewerModule | null = null;
let loading: Promise<FileViewerModule> | null = null;

/** CodeMirror stays out of the startup bundle (P-01): the viewer loads when first opened. */
function preloadFileViewer(): Promise<FileViewerModule> {
  loading ??= import('./FileViewer').then((module) => {
    loaded = module;
    return module;
  });
  return loading;
}

/** The `FileViewer` component once loaded, `null` before. */
export function useFileViewer(): FileViewerModule['FileViewer'] | null {
  const [module, setModule] = useState(loaded);
  useEffect(() => {
    if (module) return;
    let active = true;
    void preloadFileViewer().then((m) => {
      if (active) setModule(m);
    });
    return () => {
      active = false;
    };
  }, [module]);
  return module?.FileViewer ?? null;
}
