import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ipc, unwrap } from '../../ipc';
import { mockBackend } from '../../ipc/mockClient';
import { useCommitHits } from './usePaletteData';

beforeEach(() => {
  mockBackend.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useCommitHits', () => {
  it('finds commits by their message', async () => {
    const { id } = await unwrap(ipc.commands.openRepo('/Users/alex/dev/yaggui'));
    const { result } = renderHook(() => useCommitHits(id, 'fix', true));
    expect(result.current.loading).toBe(true);
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.hits.length).toBeGreaterThan(0);
  });

  it('shows no commit, not a spinner forever, when the graph moved under the search', async () => {
    const { id } = await unwrap(ipc.commands.openRepo('/Users/alex/dev/yaggui'));
    const original = ipc.commands.graphPage;
    // The rows of the search were computed for another layout than the pages that follow.
    vi.spyOn(ipc.commands, 'graphPage').mockImplementation(async (repoId, start, limit) => {
      const page = await original(repoId, start, limit);
      return page.status === 'ok'
        ? { ...page, data: { ...page.data, version: page.data.version + 1 } }
        : page;
    });
    const { result } = renderHook(() => useCommitHits(id, 'fix', true));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.hits).toEqual([]);
  });
});
