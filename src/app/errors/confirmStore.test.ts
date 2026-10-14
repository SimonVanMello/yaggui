import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_PREFERENCES, savePreferences } from '../preferences';
import { mockBackend, mockClient } from '../../ipc/mockClient';
import { confirm, isConfirmationDisabled, useConfirmStore } from './confirmStore';

const request = { title: 'Discard?', description: 'x', confirmLabel: 'Discard' };

afterEach(() => {
  useConfirmStore.getState().settle(false);
  savePreferences({ disabledConfirmations: [] }, mockClient);
  mockBackend.reset();
});

describe('confirm', () => {
  it('waits for the user by default', async () => {
    const answer = confirm({ ...request, kind: 'dropStash' });
    expect(useConfirmStore.getState().pending?.title).toBe('Discard?');
    useConfirmStore.getState().settle(true);
    await expect(answer).resolves.toBe(true);
  });

  it('answers yes at once when its confirmation is turned off', async () => {
    savePreferences({ disabledConfirmations: ['dropStash'] }, mockClient);
    await expect(confirm({ ...request, kind: 'dropStash' })).resolves.toBe(true);
    expect(useConfirmStore.getState().pending).toBeNull();
    // Another kind still asks.
    void confirm({ ...request, kind: 'deleteTag' });
    expect(useConfirmStore.getState().pending).not.toBeNull();
  });

  it('never skips the force push confirmation, even if a stored value says so', () => {
    savePreferences(
      { ...DEFAULT_PREFERENCES, disabledConfirmations: ['forcePush', 'deleteTag'] },
      mockClient,
    );
    expect(isConfirmationDisabled('forcePush')).toBe(false);
    expect(isConfirmationDisabled('deleteTag')).toBe(true);
    void confirm({ ...request, kind: 'forcePush' });
    expect(useConfirmStore.getState().pending).not.toBeNull();
  });

  it('keeps asking for requests without a kind (safety confirmations)', () => {
    savePreferences(
      { disabledConfirmations: ['discardChanges', 'deleteTag', 'dropStash'] },
      mockClient,
    );
    void confirm(request);
    expect(useConfirmStore.getState().pending).not.toBeNull();
  });
});
