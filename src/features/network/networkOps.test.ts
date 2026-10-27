import { beforeEach, describe, expect, it } from 'vitest';

import { mockBackend, mockClient } from '../../ipc/mockClient';
import { unwrap } from '../../ipc/result';
import { useToastStore } from '../../ui/toastStore';
import { useRepoSessions } from '../repo/repoSessions';
import { fetchRepo } from './networkOps';

beforeEach(() => {
  mockBackend.reset();
  useToastStore.setState({ toasts: [] });
  useRepoSessions.setState({ sessions: {} });
});

describe('network toasts', () => {
  it('name the repository, so a result among several tabs can be attributed', async () => {
    const { id } = await unwrap(mockClient.commands.openRepo('/Users/alex/dev/blog'));
    useRepoSessions.setState({ sessions: { [id]: { status: 'opening', name: 'blog' } } });

    await expect(fetchRepo(id)).resolves.toBe(true);
    expect(useToastStore.getState().toasts).toMatchObject([
      { variant: 'success', title: 'Fetch complete', description: 'blog' },
    ]);

    useToastStore.setState({ toasts: [] });
    mockBackend.addOfflineRemote(id);
    await expect(fetchRepo(id)).resolves.toBe(false);
    expect(useToastStore.getState().toasts).toMatchObject([
      { variant: 'error', title: 'Fetch failed (blog)' },
    ]);
  });
});
