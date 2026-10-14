import type { YagguiClient } from './client';
import { mockBackend, mockClient, type MockBackend } from './mockClient';
import { tauriClient } from './tauriClient';

export type {
  YagguiClient,
  YagguiCommands,
  YagguiEventHandler,
  YagguiEventMap,
  YagguiEventName,
  YagguiEvents,
  Unsubscribe,
} from './client';
export type * from './bindings';
export {
  AUTO_FETCH_MAX_MINUTES,
  AUTO_FETCH_MIN_MINUTES,
  COMPARE_MAX_COMMITS,
  EDGE_MERGE,
  EDGE_NORMAL,
  EDGE_WIP,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  GRAPH_COLORS,
  GRAPH_MAX_LANES,
  GRAPH_PAGE_SIZE,
  SCAN_DEPTH_MAX,
  SCAN_DEPTH_MIN,
  SIGNATURE_GPG,
  SIGNATURE_NONE,
  SIGNATURE_SSH,
  SIGNATURE_UNKNOWN,
  SIGNATURE_X509,
  WORKSPACE_NAME_MAX,
} from './bindings';
export { YagguiIpcError, unwrap, type IpcResult } from './result';
export { nativeWindow, type FolderDropHandlers, type NativeWindow } from './nativeWindow';
export {
  nativeMenu,
  toAccelerator,
  type MenuEntry,
  type MenuSection,
  type NativeMenu,
  type NativeMenuItem,
} from './nativeMenu';

export const isMock = import.meta.env.VITE_MOCK === '1';

declare global {
  interface Window {
    /** Mock backend controls, exposed in mock mode for Playwright and manual testing. */
    __yagguiMock?: MockBackend;
  }
}

if (isMock) window.__yagguiMock = mockBackend;

/** The only entry point to the backend for the rest of the frontend. */
export const ipc: YagguiClient = isMock ? mockClient : tauriClient;
