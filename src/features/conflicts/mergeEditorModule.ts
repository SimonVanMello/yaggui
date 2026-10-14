import { useEffect, useState } from 'react';

type MergeEditorModule = typeof import('./MergeEditor');

let loaded: MergeEditorModule | null = null;
let loading: Promise<MergeEditorModule> | null = null;

/** CodeMirror stays out of the startup bundle (P-01): the editor loads with the first conflict. */
export function preloadMergeEditor(): Promise<MergeEditorModule> {
  loading ??= import('./MergeEditor').then((module) => {
    loaded = module;
    return module;
  });
  return loading;
}

/** The `MergeEditor` component once loaded, `null` before. */
export function useMergeEditor(): MergeEditorModule['MergeEditor'] | null {
  const [module, setModule] = useState(loaded);
  useEffect(() => {
    if (module) return;
    let active = true;
    void preloadMergeEditor().then((m) => {
      if (active) setModule(m);
    });
    return () => {
      active = false;
    };
  }, [module]);
  return module?.MergeEditor ?? null;
}
