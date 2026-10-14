import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { updatePreferences } from '../../app/preferences';
import { mockBackend, mockClient } from '../../ipc/mockClient';
import { fetchRepo } from './networkOps';
import { useAutoFetch } from './useAutoFetch';

vi.mock('./networkOps', () => ({ fetchRepo: vi.fn(() => Promise.resolve(true)) }));

const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(fetchRepo).mockClear();
  mockBackend.reset();
});

afterEach(async () => {
  vi.useRealTimers();
  await updatePreferences({ autoFetch: true, autoFetchMinutes: 10 }, mockClient);
});

describe('useAutoFetch', () => {
  it('fetches silently every 10 minutes by default', async () => {
    await updatePreferences({ autoFetch: true, autoFetchMinutes: 10 }, mockClient);
    renderHook(() => {
      useAutoFetch(1);
    });
    vi.advanceTimersByTime(9 * MINUTE);
    expect(fetchRepo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MINUTE);
    expect(fetchRepo).toHaveBeenCalledTimes(1);
    expect(fetchRepo).toHaveBeenCalledWith(1, { silent: true });
  });

  it('follows the interval preference', async () => {
    await updatePreferences({ autoFetch: true, autoFetchMinutes: 2 }, mockClient);
    renderHook(() => {
      useAutoFetch(1);
    });
    vi.advanceTimersByTime(6 * MINUTE);
    expect(fetchRepo).toHaveBeenCalledTimes(3);
  });

  it('does nothing when auto-fetch is turned off', async () => {
    await updatePreferences({ autoFetch: false }, mockClient);
    renderHook(() => {
      useAutoFetch(1);
    });
    vi.advanceTimersByTime(60 * MINUTE);
    expect(fetchRepo).not.toHaveBeenCalled();
  });

  it('starts and stops when the preference changes while the tab is open', async () => {
    await updatePreferences({ autoFetch: true, autoFetchMinutes: 1 }, mockClient);
    renderHook(() => {
      useAutoFetch(1);
    });
    vi.advanceTimersByTime(MINUTE);
    expect(fetchRepo).toHaveBeenCalledTimes(1);
    await act(async () => {
      await updatePreferences({ autoFetch: false }, mockClient);
    });
    vi.advanceTimersByTime(5 * MINUTE);
    expect(fetchRepo).toHaveBeenCalledTimes(1);
  });
});
