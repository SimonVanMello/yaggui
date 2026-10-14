import type { MockBackend } from '../src/ipc/mockClient';

declare global {
  interface Window {
    /** Mock backend controls exposed by `pnpm dev` (see src/ipc/index.ts). */
    __yagguiMock?: MockBackend;
  }
}
