import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_AI_PREFERENCES } from '../aiDefaults';
import { mockBackend, mockClient } from '../mockClient';
import { unwrap } from '../result';
import { guessMessage, matchesExcluded, normalizeAi } from './ai';

const { commands: mock } = mockClient;

beforeEach(() => {
  mockBackend.reset();
  mockBackend.simulateAiLatency(20);
});

afterEach(() => {
  vi.useRealTimers();
});

async function openYaggui(): Promise<number> {
  const { id } = await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
  return id;
}

async function enable(): Promise<void> {
  const prefs = await unwrap(mock.getPreferences());
  await unwrap(mock.setPreferences({ ...prefs, aiEnabled: true }));
}

describe('mock AI preferences', () => {
  it('validates like the backend', () => {
    expect(normalizeAi(DEFAULT_AI_PREFERENCES)).toEqual({ ok: DEFAULT_AI_PREFERENCES });
    for (const patch of [
      { maxDiffBytes: 100 },
      { maxFileBytes: 5_000_000 },
      { recentSubjects: 51 },
      { timeoutSeconds: 5 },
      { customPrompt: 'x'.repeat(20_001) },
      { claudeApi: { model: '-rm -rf' } },
    ]) {
      expect(normalizeAi({ ...DEFAULT_AI_PREFERENCES, ...patch })).toHaveProperty('error');
    }
  });

  it('cleans the lists and texts', () => {
    const result = normalizeAi({
      ...DEFAULT_AI_PREFERENCES,
      excludedPaths: [' *.lock ', '', '*.lock'],
      customPrompt: '   ',
      claudeApi: { model: ' ' },
      claudeCode: { model: ' haiku ', skill: '' },
    });
    expect(result).toMatchObject({
      ok: {
        excludedPaths: ['*.lock'],
        customPrompt: null,
        claudeApi: { model: 'claude-haiku-5-5' },
        claudeCode: { model: 'haiku', skill: null },
      },
    });
  });

  it('stores them through setPreferences and refuses invalid ones', async () => {
    const prefs = await unwrap(mock.getPreferences());
    expect(prefs).toMatchObject({ aiEnabled: false, ai: DEFAULT_AI_PREFERENCES });
    await expect(
      mock.setPreferences({ ...prefs, ai: { ...DEFAULT_AI_PREFERENCES, timeoutSeconds: 1 } }),
    ).resolves.toMatchObject({ status: 'error', error: { code: 'invalidArgument' } });
    expect((await unwrap(mock.getPreferences())).ai).toEqual(DEFAULT_AI_PREFERENCES);
  });

  it('matches excluded paths like the backend', () => {
    const patterns = ['*.lock', 'vendor/**', 'package-lock.json'];
    expect(matchesExcluded('a/b/yarn.lock', patterns)).toBe(true);
    expect(matchesExcluded('vendor/x/y.js', patterns)).toBe(true);
    expect(matchesExcluded('src/vendor/y.js', patterns)).toBe(false);
    expect(matchesExcluded('web/package-lock.json', patterns)).toBe(true);
    expect(matchesExcluded('src/app.ts', patterns)).toBe(false);
  });
});

describe('mock AI status and key', () => {
  it('lists the providers as data and never exposes a key', async () => {
    const { providers } = await unwrap(mock.aiStatus());
    expect(providers.map((p) => p.kind)).toEqual(['claudeApi', 'claudeCode']);
    expect(providers[0]).toMatchObject({
      ready: false,
      credential: { kind: 'apiKey', source: 'none' },
      problem: { code: 'aiNotConfigured' },
    });
    expect(providers[1]).toMatchObject({ ready: true, credential: { kind: 'cli' } });

    await unwrap(mock.aiSetApiKey('claudeApi', 'sk-ant-secret'));
    const after = (await unwrap(mock.aiStatus())).providers[0];
    expect(after).toMatchObject({ ready: true, credential: { source: 'keychain' } });
    expect(JSON.stringify(after)).not.toContain('secret');

    await unwrap(mock.aiClearApiKey('claudeApi'));
    expect((await unwrap(mock.aiStatus())).providers[0]?.ready).toBe(false);
  });

  it('refuses an empty key and reports a missing keychain', async () => {
    await expect(mock.aiSetApiKey('claudeApi', '  ')).resolves.toMatchObject({
      status: 'error',
      error: { code: 'invalidArgument' },
    });
    mockBackend.simulateAiSetup({ keychainAvailable: false });
    await expect(mock.aiSetApiKey('claudeApi', 'sk-ant-x')).resolves.toMatchObject({
      status: 'error',
      error: { code: 'aiKeychainUnavailable' },
    });
  });

  it('follows the configured program path', async () => {
    mockBackend.simulateAiSetup({ claudeInstalled: false });
    expect((await unwrap(mock.aiStatus())).providers[1]).toMatchObject({
      ready: false,
      credential: { path: null },
    });
    const prefs = await unwrap(mock.getPreferences());
    await unwrap(mock.setPreferences({ ...prefs, claudePath: '/opt/claude' }));
    expect((await unwrap(mock.aiStatus())).providers[1]).toMatchObject({
      ready: true,
      credential: { path: '/opt/claude', configured: true },
    });
  });

  it('lists the repository skills only for a repository', async () => {
    const withRepo = await unwrap(mock.aiListSkills(1));
    const without = await unwrap(mock.aiListSkills(null));
    expect(withRepo.some((s) => s.scope === 'project')).toBe(true);
    expect(without.some((s) => s.scope === 'project')).toBe(false);
  });
});

describe('mock AI generation', () => {
  it('refuses while the feature is off', async () => {
    const id = await openYaggui();
    await expect(mock.aiGenerateCommitMessage(id, false)).resolves.toMatchObject({
      status: 'error',
      error: { code: 'aiDisabled', action: { kind: 'configureAi' } },
    });
  });

  it('asks for a provider that is not ready', async () => {
    const id = await openYaggui();
    await enable();
    await expect(mock.aiGenerateCommitMessage(id, false)).resolves.toMatchObject({
      status: 'error',
      error: { code: 'aiNotConfigured' },
    });
  });

  it('writes a conventional message from the staged files and logs it without the diff', async () => {
    const id = await openYaggui();
    await enable();
    await unwrap(mock.aiSetApiKey('claudeApi', 'sk-ant-secret'));
    const staged = await unwrap(mock.changedFiles(id, { kind: 'staged' }));
    expect(staged.files.length).toBeGreaterThan(0);

    const result = await unwrap(mock.aiGenerateCommitMessage(id, false));
    expect(result.summary).toMatch(/^[a-z]+(\([^)]+\))?: .+/);
    expect(result.provider).toBe('claudeApi');
    expect(result.context.files).toBe(staged.files.length);
    const log = await unwrap(mock.commandLog());
    const entry = log.at(-1);
    expect(entry).toMatchObject({ program: 'claude-api', status: 'success' });
    expect(JSON.stringify(entry)).not.toContain('secret');
  });

  it('is cancelled by aiCancel', async () => {
    const id = await openYaggui();
    await enable();
    await unwrap(mock.aiSetApiKey('claudeApi', 'sk-ant-secret'));
    mockBackend.simulateAiLatency(60_000);
    const pending = mock.aiGenerateCommitMessage(id, false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(mock.aiGenerateCommitMessage(id, false)).resolves.toMatchObject({
      error: { code: 'aiBusy' },
    });
    await unwrap(mock.aiCancel(id));
    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: { code: 'cancelled' },
    });
  });

  it('fails with the simulated error, once or until cleared', async () => {
    const id = await openYaggui();
    await enable();
    await unwrap(mock.aiSetApiKey('claudeApi', 'sk-ant-secret'));
    mockBackend.simulateAiFailure('aiRateLimited');
    await expect(mock.aiGenerateCommitMessage(id, false)).resolves.toMatchObject({
      error: { code: 'aiRateLimited', action: { kind: 'retry' } },
    });
    await expect(mock.aiGenerateCommitMessage(id, false)).resolves.toMatchObject({
      status: 'ok',
    });
    mockBackend.simulateAiFailure('aiAuthFailed', true);
    for (let i = 0; i < 2; i++) {
      await expect(mock.aiGenerateCommitMessage(id, false)).resolves.toMatchObject({
        error: { code: 'aiAuthFailed' },
      });
    }
  });

  it('tests a provider with the saved settings', async () => {
    await expect(mock.aiTestProvider('claudeApi')).resolves.toMatchObject({
      error: { code: 'aiNotConfigured' },
    });
    const ok = await unwrap(mock.aiTestProvider('claudeCode'));
    expect(ok).toMatchObject({ provider: 'claudeCode', reply: 'OK' });
  });

  it('previews the exact context, honoring the exclusions', async () => {
    const id = await openYaggui();
    const preview = await unwrap(mock.aiPreviewContext(id, false));
    expect(preview.text).toContain('Changed files:');
    expect(preview.summary.files).toBeGreaterThan(0);
  });
});

describe('guessed message', () => {
  const file = (path: string, status = 'modified') => ({
    path,
    status,
    bytes: 100,
    binary: false,
  });

  it('scopes to the feature folder and types from the paths', () => {
    expect(guessMessage([file('src/features/graph/Lanes.ts', 'added')], 'en').summary).toBe(
      'feat(graph): add Lanes',
    );
    expect(guessMessage([file('docs/SPEC.md')], 'en').summary).toMatch(/^docs/);
    expect(guessMessage([file('a.test.ts'), file('b.test.ts')], 'en').summary).toMatch(/^test/);
  });

  it('writes French when asked', () => {
    const { summary, description } = guessMessage([file('src/app/App.tsx')], 'fr');
    expect(summary).toContain('corriger');
    expect(description).toContain('Modifications');
  });
});
