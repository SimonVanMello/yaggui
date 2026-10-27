import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { savePreferences } from '../../app/preferences';
import { queryClient } from '../../app/queryClient';
import { unwrap } from '../../ipc';
import { mockBackend, mockClient } from '../../ipc/mockClient';
import { invalidateRemoteTags, relistRemoteTags, useRemoteTags } from './remoteTags';

const { commands: mock } = mockClient;

function Probe({ repoId }: { repoId: number }) {
  const tags = useRemoteTags(repoId);
  return <output>{tags === null ? 'none' : JSON.stringify([...tags.entries()])}</output>;
}

function renderProbe(repoId: number) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Probe repoId={repoId} />
    </QueryClientProvider>,
  );
}

async function openWithPushedTag(): Promise<{ id: number; tag: string }> {
  const id = (await unwrap(mock.openRepo('/Users/alex/dev/yaggui'))).id;
  const tag = (await unwrap(mock.listRefs(id))).tags[0]?.name;
  if (tag === undefined) throw new Error('the mock repository has no tag');
  await unwrap(mock.pushTag(id, 'origin', tag));
  return { id, tag };
}

beforeEach(() => {
  mockBackend.reset();
  queryClient.clear();
});

afterEach(() => {
  savePreferences({ remoteTags: false });
});

describe('remote tags', () => {
  it('asks the backend for nothing while the preference is off', async () => {
    const { id } = await openWithPushedTag();
    renderProbe(id);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('status').textContent).toBe('none');
    expect(mockBackend.remoteTagRequests).toEqual([]);
  });

  it('lists the tags of the remotes, and asks them again only after a network operation', async () => {
    const { id, tag } = await openWithPushedTag();
    savePreferences({ remoteTags: true });
    renderProbe(id);
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(JSON.stringify([[tag, ['origin']]]));
    });
    expect(mockBackend.remoteTagRequests).toEqual([false]);

    // Local tags changed: compared again with the last listing.
    act(() => {
      invalidateRemoteTags(id);
    });
    await waitFor(() => {
      expect(mockBackend.remoteTagRequests).toEqual([false, false]);
    });
    // After a fetch, pull or push: the remotes are asked again, once.
    act(() => {
      relistRemoteTags(id);
    });
    await waitFor(() => {
      expect(mockBackend.remoteTagRequests).toEqual([false, false, true]);
    });
    act(() => {
      invalidateRemoteTags(id);
    });
    await waitFor(() => {
      expect(mockBackend.remoteTagRequests).toEqual([false, false, true, false]);
    });
  });
});
