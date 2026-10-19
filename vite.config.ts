import { readFileSync } from 'node:fs';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import { xtermCsp } from './vite/xtermCsp';

const host = process.env.TAURI_DEV_HOST;

// `pnpm dev` (mock) gets its own port so Playwright never reuses a `pnpm tauri dev` server.
const MOCK_PORT = 1430;
const TAURI_PORT = 1420;

export default defineConfig(({ mode }) => ({
  plugins: [react(), xtermCsp()],
  // Served as is in dev too, so the CSP patch of `vite/xtermCsp.ts` applies (no pre-bundling).
  optimizeDeps: { exclude: ['@xterm/xterm'] },
  // Tauri expects a fixed port and shows its own errors.
  clearScreen: false,
  server: {
    port: mode === 'mock' ? MOCK_PORT : TAURI_PORT,
    strictPort: true,
    host: host ?? false,
    hmr: host ? { protocol: 'ws', host, port: TAURI_PORT + 1 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  // The demo shows the real version, not the mock's.
  define:
    mode === 'demo'
      ? {
          'import.meta.env.VITE_APP_VERSION': JSON.stringify(
            (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version,
          ),
        }
      : {},
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // Tauri webviews: WebView2 (Chromium), WKWebView and WebKitGTK (Safari 15+ equivalent).
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome110' : 'safari15',
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
  css: {
    modules: { localsConvention: 'camelCaseOnly' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Unit tests run against the in-memory mock backend.
    env: { VITE_MOCK: '1' },
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    css: { modules: { classNameStrategy: 'non-scoped' } },
  },
}));
