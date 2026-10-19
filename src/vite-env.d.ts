/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `1` when the frontend runs against the in-browser mock backend. */
  readonly VITE_MOCK?: string;
  /** `1` in the website's live demo build (`pnpm build:demo`). */
  readonly VITE_DEMO?: string;
  /** App version (root package.json), injected in the demo build only. */
  readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
