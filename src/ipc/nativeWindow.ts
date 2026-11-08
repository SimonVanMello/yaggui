import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { platform } from '../ui/platform';
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
   * the returned promise, and stays open when it resolves `false`. Not called on a quit that
   * skips the window (⌘Q and the Dock on macOS, see `quit-requested`). In the browser it runs
   * on page unload, which can neither wait nor be cancelled: `vetoable` is then `false`.
   */
  onCloseRequested: (handler: (request: CloseRequest) => Promise<boolean>) => Unsubscribe;
  /** Window title (taskbar, window switcher; the macOS title bar). */
  setTitle: (title: string) => Promise<void>;
  /** Zoom of the whole interface (`1` is 100 %). */
  setZoom: (factor: number) => Promise<void>;
  /**
   * Whether `devicePixelRatio` already includes the zoom. Chromium (WebView2) scales it with
   * the page zoom; WebKit (macOS, Linux) keeps the screen's, and so does a CSS zoom. A canvas
   * sized from `devicePixelRatio` alone would be blurry there.
   */
  readonly zoomInPixelRatio: boolean;
}

export interface CloseRequest {
  /** Whether the handler can keep the window open (and ask the user first). */
  vetoable: boolean;
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
  setTitle: (title) => getCurrentWindow().setTitle(title),
  onCloseRequested(handler) {
    let unlisten: (() => void) | undefined;
    let active = true;
    // With a listener, Tauri leaves the close to it: the window is destroyed once the handler
    // returns, unless it prevents the close. That destroy is a call from the webview: without
    // `core:window:allow-destroy` it is refused and the window stays.
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (!active) return;
        if (!(await handler({ vetoable: true }))) event.preventDefault();
      })
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
  setZoom: (factor) => getCurrentWebview().setZoom(factor),
  zoomInPixelRatio: platform === 'windows',
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
  // No page zoom API in a browser: CSS `zoom` scales the layout the same way (mock, Playwright).
  setZoom(factor) {
    const root = document.documentElement;
    if (factor === 1) root.style.removeProperty('zoom');
    else root.style.setProperty('zoom', String(factor));
    return Promise.resolve();
  },
  zoomInPixelRatio: false,
  // Read by the Playwright specs.
  setTitle: (title) => {
    document.title = title;
    return Promise.resolve();
  },
  onCloseRequested(handler) {
    const onBeforeUnload = () => {
      void handler({ vetoable: false });
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
