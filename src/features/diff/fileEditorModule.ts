import { useEffect, useState } from 'react';

type FileEditorModule = typeof import('./FileEditor');

let loaded: FileEditorModule | null = null;
let loading: Promise<FileEditorModule> | null = null;

/** CodeMirror stays out of the startup bundle (P-01): the editor loads when first opened. */
function preloadFileEditor(): Promise<FileEditorModule> {
  loading ??= import('./FileEditor').then((module) => {
    loaded = module;
    return module;
  });
  return loading;
}

/** The `FileEditor` component once loaded, `null` before. */
export function useFileEditor(): FileEditorModule['FileEditor'] | null {
  const [module, setModule] = useState(loaded);
  useEffect(() => {
    if (module) return;
    let active = true;
    void preloadFileEditor().then((m) => {
      if (active) setModule(m);
    });
    return () => {
      active = false;
    };
  }, [module]);
  return module?.FileEditor ?? null;
}
