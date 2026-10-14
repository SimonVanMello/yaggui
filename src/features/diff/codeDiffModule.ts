import { useEffect, useState } from 'react';

type CodeDiffModule = typeof import('./CodeDiff');

let loaded: CodeDiffModule | null = null;
let loading: Promise<CodeDiffModule> | null = null;

/**
 * CodeMirror stays out of the startup bundle (P-01): it loads with the first diff, or before
 * when the browser is idle and a file list is on screen (`preloadCodeDiffWhenIdle`).
 */
export function preloadCodeDiff(): Promise<CodeDiffModule> {
  loading ??= import('./CodeDiff').then((module) => {
    loaded = module;
    return module;
  });
  return loading;
}

/**
 * The `CodeDiff` component once loaded, `null` before. Not `React.lazy`: a Suspense reveal is
 * throttled by ~300 ms in React 19, far above the P-06 budget.
 */
export function useCodeDiff(): CodeDiffModule['CodeDiff'] | null {
  const [module, setModule] = useState(loaded);
  useEffect(() => {
    if (module) return;
    let active = true;
    void preloadCodeDiff().then((m) => {
      if (active) setModule(m);
    });
    return () => {
      active = false;
    };
  }, [module]);
  return module?.CodeDiff ?? null;
}

/** Preloads when the main thread is idle (falls back to a short delay without the API). */
export function preloadCodeDiffWhenIdle(): () => void {
  if ('requestIdleCallback' in window) {
    const handle = window.requestIdleCallback(() => void preloadCodeDiff());
    return () => {
      window.cancelIdleCallback(handle);
    };
  }
  const timer = setTimeout(() => void preloadCodeDiff(), 500);
  return () => {
    clearTimeout(timer);
  };
}
