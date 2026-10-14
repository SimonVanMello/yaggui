import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ipc, type YagguiError } from '../../ipc';
import { NAME_CHECK_DELAY_MS, useRefNameCheck } from './useRefNameCheck';

const invalid: YagguiError = {
  code: 'invalidRefName',
  message: { en: 'bad', fr: 'mauvais' },
  action: null,
  detail: null,
  payload: null,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useRefNameCheck', () => {
  it('waits for typing to pause, then validates once', async () => {
    const spy = vi.spyOn(ipc.commands, 'validateRefName').mockResolvedValue({
      status: 'ok',
      data: null,
    });
    const { result, rerender } = renderHook(({ name }) => useRefNameCheck(1, 'branch', name), {
      initialProps: { name: 'f' },
    });
    rerender({ name: 'fe' });
    rerender({ name: 'feat' });
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NAME_CHECK_DELAY_MS);
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(1, 'branch', 'feat');
    expect(result.current.status).toBe('valid');
  });

  it('reports the typed error and forgets the verdict when the name changes', async () => {
    vi.spyOn(ipc.commands, 'validateRefName').mockResolvedValue({
      status: 'error',
      error: invalid,
    });
    const { result, rerender } = renderHook(({ name }) => useRefNameCheck(1, 'tag', name), {
      initialProps: { name: 'a b' },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NAME_CHECK_DELAY_MS);
    });
    expect(result.current).toEqual({ status: 'invalid', error: invalid });
    rerender({ name: 'a b c' });
    expect(result.current.status).toBe('idle');
  });

  it('drops the reply of a name that is no longer current', async () => {
    let resolveFirst: (value: { status: 'error'; error: YagguiError }) => void = () => undefined;
    vi.spyOn(ipc.commands, 'validateRefName')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({ status: 'ok', data: null });
    const { result, rerender } = renderHook(({ name }) => useRefNameCheck(1, 'branch', name), {
      initialProps: { name: 'one' },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NAME_CHECK_DELAY_MS);
    });
    rerender({ name: 'two' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NAME_CHECK_DELAY_MS);
    });
    await act(async () => {
      resolveFirst({ status: 'error', error: invalid });
      await Promise.resolve();
    });
    expect(result.current.status).toBe('valid');
  });

  it('stays idle for an empty or skipped name', async () => {
    const spy = vi.spyOn(ipc.commands, 'validateRefName');
    const { result } = renderHook(() => useRefNameCheck(1, 'branch', 'same', true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NAME_CHECK_DELAY_MS * 2);
    });
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });
});
