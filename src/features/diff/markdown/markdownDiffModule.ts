import { useEffect, useState } from 'react';

type MarkdownDiffModule = typeof import('./MarkdownDiff');

let loaded: MarkdownDiffModule | null = null;
let loading: Promise<MarkdownDiffModule> | null = null;

/** The Markdown parser stays out of the startup bundle: it loads with the first preview. */
export function preloadMarkdownDiff(): Promise<MarkdownDiffModule> {
  loading ??= import('./MarkdownDiff').then((module) => {
    loaded = module;
    return module;
  });
  return loading;
}

/** The `MarkdownDiff` component once loaded, `null` before (see `useCodeDiff`). */
export function useMarkdownDiff(): MarkdownDiffModule['MarkdownDiff'] | null {
  const [module, setModule] = useState(loaded);
  useEffect(() => {
    if (module) return;
    let active = true;
    void preloadMarkdownDiff().then((m) => {
      if (active) setModule(m);
    });
    return () => {
      active = false;
    };
  }, [module]);
  return module?.MarkdownDiff ?? null;
}
