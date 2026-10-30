import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';

import type { Unsubscribe } from './client';

/**
 * Window-level integration (window buttons, folder drop). Not part of the generated contract:
 * these go through Tauri's core window/webview APIs, and degrade to browser behavior in mock mode.
 */
export interface FolderDropHandlers {
  /** A drag carrying files entered the window. */
  onEnter: () => void;
  onLeave: () => void;
  /** Absolute paths of the dropped items. */
  onDrop: (paths: string[]) => void;
}

export interface NativeWindow {
  /** Whether the window buttons are drawn by the app (Windows/Linux undecorated window). */
  readonly isNative: boolean;
  show: () => Promise<void>;
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  /** Called after every resize (maximize, restore, snap…). */
  subscribeResized: (handler: () => void) => Unsubscribe;
  subscribeFolderDrop: (handlers: FolderDropHandlers) => Unsubscribe;
  /**
   * Called when the window is about to close (its button, `close()`): the window waits for
   * the returned promise. Not called on a quit that skips the window (⌘Q on macOS).
   */
  onCloseRequested: (handler: () => Promise<void>) => Unsubscribe;
}

const tauriWindow: NativeWindow = {
  isNative: true,
  show: () => getCurrentWindow().show(),
  minimize: () => getCurrentWindow().minimize(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
  close: () => getCurrentWindow().close(),
  isMaximized: () => getCurrentWindow().isMaximized(),
  subscribeResized(handler) {
    let unlisten: (() => void) | undefined;
    let active = true;
    getCurrentWindow()
      .onResized(() => {
        handler();
      })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch((error: unknown) => {
        console.warn('Could not watch the window size', error);
      });
    return () => {
      active = false;
      unlisten?.();
    };
  },
  subscribeFolderDrop(handlers) {
    let unlisten: (() => void) | undefined;
    let active = true;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === 'enter') handlers.onEnter();
        else if (payload.type === 'leave') handlers.onLeave();
        else if (payload.type === 'drop') handlers.onDrop(payload.paths);
      })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch((error: unknown) => {
        console.warn('Could not watch folder drops', error);
      });
    return () => {
      active = false;
      unlisten?.();
    };
  },
  onCloseRequested(handler) {
    let unlisten: (() => void) | undefined;
    let active = true;
    // With a listener, Tauri leaves the close to it: the window is destroyed once the handler
    // returns (unless it prevents the close, which this one never does). That destroy is a call
    // from the webview: without `core:window:allow-destroy` it is refused and the window stays.
    getCurrentWindow()
      .onCloseRequested(() => (active ? handler() : Promise.resolve()))
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch((error: unknown) => {
        console.warn('Could not watch the window close', error);
      });
    return () => {
      active = false;
      unlisten?.();
    };
  },
};

/** Extracts absolute paths from a browser drop (`text/uri-list` with `file://` URIs, or plain paths). */
export function pathsFromDataTransfer(data: DataTransfer): string[] {
  const uris = data
    .getData('text/uri-list')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('file://'))
    .map((line) => decodeURIComponent(new URL(line).pathname));
  if (uris.length > 0) return uris;
  return data
    .getData('text/plain')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/') || /^[a-z]:[\\/]/i.test(line));
}

function hasDroppable(event: DragEvent): boolean {
  const types = event.dataTransfer?.types ?? [];
  return types.includes('Files') || types.includes('text/uri-list');
}

const browserWindow: NativeWindow = {
  isNative: false,
  show: () => Promise.resolve(),
  minimize: () => Promise.resolve(),
  toggleMaximize: () => Promise.resolve(),
  close: () => Promise.resolve(),
  isMaximized: () => Promise.resolve(false),
  subscribeResized: () => () => undefined,
  onCloseRequested(handler) {
    const onBeforeUnload = () => {
      void handler();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  },
  subscribeFolderDrop(handlers) {
    // dragenter/dragleave fire for every child element: count them to know when the drag leaves.
    let depth = 0;
    const onEnter = (event: DragEvent) => {
      if (!hasDroppable(event)) return;
      event.preventDefault();
      if (depth++ === 0) handlers.onEnter();
    };
    const onOver = (event: DragEvent) => {
      if (hasDroppable(event)) event.preventDefault();
    };
    const onLeave = () => {
      if (depth > 0 && --depth === 0) handlers.onLeave();
    };
    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer || !hasDroppable(event)) return;
      event.preventDefault();
      depth = 0;
      handlers.onDrop(pathsFromDataTransfer(event.dataTransfer));
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  },
};

export const nativeWindow: NativeWindow =
  import.meta.env.VITE_MOCK === '1' ? browserWindow : tauriWindow;
