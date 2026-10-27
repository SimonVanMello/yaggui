import { demoClient } from '../demo/demoClient';
import { isDemo } from '../demo/isDemo';
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
  AI_DIFF_BYTES_MAX,
  AI_DIFF_BYTES_MIN,
  AI_FILE_BYTES_MAX,
  AI_FILE_BYTES_MIN,
  AI_PROMPT_MAX,
  AI_RECENT_SUBJECTS_MAX,
  AI_TIMEOUT_MAX,
  AI_TIMEOUT_MIN,
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
export { DEFAULT_AI_PREFERENCES } from './aiDefaults';
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
    /**
     * Set by a Playwright init script to prepare the mock before the app reads anything
     * (preferences, startup checks).
     */
    __yagguiMockSetup?: (mock: MockBackend) => void;
  }
}

if (isMock) {
  window.__yagguiMock = mockBackend;
  window.__yagguiMockSetup?.(mockBackend);
}

/** The only entry point to the backend for the rest of the frontend. */
export const ipc: YagguiClient = isMock
  ? isDemo
    ? demoClient(mockClient)
    : mockClient
  : tauriClient;
