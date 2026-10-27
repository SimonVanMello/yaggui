import type { AiPreferences } from './bindings';

/** `AiPreferences::default()` in `src-tauri/src/ai/types.rs`. */
export const DEFAULT_AI_PREFERENCES: AiPreferences = {
  provider: 'claudeApi',
  claudeApi: { model: 'claude-haiku-5-5' },
  claudeCode: { model: null, skill: null },
  customPrompt: null,
  maxDiffBytes: 60_000,
  maxFileBytes: 12_000,
  excludedPaths: [
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb',
    'Cargo.lock',
    'Gemfile.lock',
    'composer.lock',
    'poetry.lock',
    'uv.lock',
    'go.sum',
    '*.min.js',
    '*.min.css',
  ],
  recentSubjects: 10,
  language: 'auto',
  timeoutSeconds: 120,
};
