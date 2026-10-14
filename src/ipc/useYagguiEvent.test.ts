import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockBackend } from './mockClient';
import { useYagguiEvent } from './useYagguiEvent';

beforeEach(() => {
  mockBackend.reset();
});

describe('useYagguiEvent', () => {
  it('delivers events to the latest handler and unsubscribes on unmount', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ handler }) => {
        useYagguiEvent('refsChanged', handler);
      },
      { initialProps: { handler: first } },
    );

    act(() => {
      mockBackend.emit('refsChanged', { repoId: 1 });
    });
    expect(first).toHaveBeenCalledWith({ repoId: 1 });

    rerender({ handler: second });
    act(() => {
      mockBackend.emit('refsChanged', { repoId: 2 });
    });
    expect(second).toHaveBeenCalledWith({ repoId: 2 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(mockBackend.events.listenerCount('refsChanged')).toBe(1);

    unmount();
    expect(mockBackend.events.listenerCount('refsChanged')).toBe(0);
  });
});
