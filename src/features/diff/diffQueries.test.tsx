import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ipc, type DiffOptions, type DiffTarget, type FileDiff } from '../../ipc';
import { diffKeys, placeholderFor, useFileDiff } from './diffQueries';

const options: DiffOptions = {
  ignoreWhitespace: false,
  contextLines: 3,
  fullFile: false,
  force: false,
};
const STAGED: DiffTarget = { kind: 'staged' };
const UNSTAGED: DiffTarget = { kind: 'unstaged' };

function diffOf(path: string): FileDiff {
  return {
    path,
    oldPath: null,
    oldId: null,
    newId: null,
    oldMode: 'regular',
    newMode: 'regular',
    content: { kind: 'conflict' },
  };
}

describe('placeholderFor', () => {
  it('accepts the previous diff only from the same list', () => {
    const unstaged = diffKeys.file(1, UNSTAGED, 'a.ts', null, options);
    expect(placeholderFor(unstaged, UNSTAGED)).toBe(true);
    expect(placeholderFor(unstaged, STAGED)).toBe(false);
    expect(placeholderFor(unstaged, { kind: 'commits', from: 'a', to: 'b' })).toBe(false);
    expect(placeholderFor(undefined, UNSTAGED)).toBe(false);
  });
});

describe('useFileDiff', () => {
  it('keeps the previous file as placeholder within a list, never across lists', async () => {
    const spy = vi.spyOn(ipc.commands, 'fileDiff');
    spy.mockResolvedValueOnce({ status: 'ok', data: diffOf('a.ts') });
    // The later diffs never arrive: what shows meanwhile is the point.
    spy.mockImplementation(() => new Promise(() => undefined));
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const props = (target: DiffTarget, path: string) => ({ target, path });
    const { result, rerender } = renderHook(
      ({ target, path }: ReturnType<typeof props>) => useFileDiff(1, target, path, null, options),
      { wrapper, initialProps: props(UNSTAGED, 'a.ts') },
    );
    await waitFor(() => {
      expect(result.current.data?.path).toBe('a.ts');
    });

    // The same file in the staged list: its unstaged hunks are not shown under that title.
    rerender(props(STAGED, 'a.ts'));
    expect(result.current.data).toBeUndefined();

    // Another file of the same list: the previous one stays on screen while it loads.
    rerender(props(UNSTAGED, 'b.ts'));
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data?.path).toBe('a.ts');
  });
});
