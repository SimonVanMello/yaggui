import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { savePreferences } from '../../app/preferences';
import { useShellStore } from '../../app/shellStore';
import { ipc, unwrap } from '../../ipc';
import { mockBackend } from '../../ipc/mockClient';
import { useToastStore } from '../../ui/toastStore';
import { cancelGeneration, generateCommitMessage, restoreAiMessage } from './aiGenerate';
import { useAiUi } from './aiMessage';
import { EMPTY_DRAFT, useCommitDrafts } from './commitDraft';
import { useCommitTools } from './commitToolsStore';
import { parseConventional } from './conventional';

let repoId = 0;

beforeEach(async () => {
  mockBackend.reset();
  mockBackend.simulateAiLatency(10);
  mockBackend.simulateAiSetup({ keySource: 'keychain' });
  useToastStore.setState({ toasts: [] });
  useCommitDrafts.setState({ drafts: {} });
  useAiUi.setState({ generating: {}, restore: {} });
  repoId = (await unwrap(ipc.commands.openRepo('/Users/alex/dev/yaggui'))).id;
  savePreferences({ aiEnabled: true });
});

afterEach(() => {
  savePreferences({ aiEnabled: false });
});

const draft = () => useCommitDrafts.getState().drafts[repoId] ?? EMPTY_DRAFT;
const titles = () => useToastStore.getState().toasts.map((toast) => toast.title);

describe('generateCommitMessage', () => {
  it('fills the draft and offers to restore the message it replaced', async () => {
    useCommitDrafts.getState().update(repoId, { summary: 'wip', description: 'notes' });
    await generateCommitMessage(repoId);

    expect(draft().summary).not.toBe('wip');
    expect(draft().description).not.toBe('notes');
    expect(useAiUi.getState().generating[repoId]).toBeUndefined();
    const toast = useToastStore.getState().toasts.find((t) => t.title === 'Message generated');
    expect(toast?.action?.label).toBe('Restore previous message');

    toast?.action?.onClick();
    expect(draft()).toMatchObject({ summary: 'wip', description: 'notes' });
    expect(useAiUi.getState().restore[repoId]).toBeUndefined();
  });

  it('offers no restore over an empty draft', async () => {
    await generateCommitMessage(repoId);
    expect(useAiUi.getState().restore[repoId]).toBeUndefined();
    expect(useToastStore.getState().toasts[0]?.action).toBeUndefined();
  });

  it('keeps the amend state and drops the pre-filled marker', async () => {
    useCommitDrafts.getState().set(repoId, {
      summary: 'old',
      description: '',
      amend: true,
      prefilled: { summary: 'old', description: '' },
    });
    await generateCommitMessage(repoId);
    expect(draft()).toMatchObject({ amend: true, prefilled: null });
    expect(mockBackend.aiGenerations).toEqual([{ repoId, amend: true, conventional: false }]);
  });

  it('asks for a Conventional Commits header while the helper is on', async () => {
    useCommitTools.getState().setConventional(true);
    try {
      await generateCommitMessage(repoId);
    } finally {
      useCommitTools.getState().setConventional(false);
    }
    expect(mockBackend.aiGenerations).toEqual([{ repoId, amend: false, conventional: true }]);
    expect(parseConventional(draft().summary)).not.toBeNull();
  });

  it('does not overwrite what was typed after the restore became stale', async () => {
    useCommitDrafts.getState().update(repoId, { summary: 'wip' });
    await generateCommitMessage(repoId);
    useCommitDrafts.getState().update(repoId, { summary: 'typed after' });
    restoreAiMessage(repoId);
    expect(draft().summary).toBe('typed after');
    expect(titles()).toContain('The message was edited since: nothing to restore');
  });

  it('is cancelled silently, leaving the draft alone', async () => {
    mockBackend.simulateAiLatency(60_000);
    useCommitDrafts.getState().update(repoId, { summary: 'wip' });
    const running = generateCommitMessage(repoId);
    expect(useAiUi.getState().generating[repoId]).toBe(true);
    // A second click while it runs does nothing.
    await generateCommitMessage(repoId);
    expect(mockBackend.aiGenerations).toHaveLength(1);
    cancelGeneration(repoId);
    await running;
    expect(draft().summary).toBe('wip');
    expect(useAiUi.getState().generating[repoId]).toBeUndefined();
    expect(titles()).toEqual([]);
  });

  it('shows a typed error with its action and keeps the draft', async () => {
    mockBackend.simulateAiFailure('aiRateLimited');
    useCommitDrafts.getState().update(repoId, { summary: 'wip' });
    await generateCommitMessage(repoId);
    const toast = useToastStore.getState().toasts[0];
    expect(toast).toMatchObject({ variant: 'error', title: 'Could not generate a message' });
    expect(toast?.action?.label).toBe('Retry');
    expect(draft().summary).toBe('wip');
  });

  it('opens the AI preferences instead when the feature is off', async () => {
    savePreferences({ aiEnabled: false });
    await generateCommitMessage(repoId);
    expect(mockBackend.aiGenerations).toEqual([]);
    expect(useShellStore.getState()).toMatchObject({ preferencesOpen: true, preferencesTab: 'ai' });
  });
});
