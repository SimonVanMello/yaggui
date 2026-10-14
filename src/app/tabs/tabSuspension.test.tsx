import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { Activity, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockBackend } from '../../ipc/mockClient';
import { refetchOnMount, useRepoEvent, useRevealGuard } from './tabSuspension';

beforeEach(() => {
  mockBackend.reset();
});

/** Root of a kept view, like `TabBody`: the guard sits above the query observers. */
function Root({ children }: { children: ReactNode }) {
  useRevealGuard();
  return children;
}

interface Spies {
  render: () => void;
  fetchFresh: () => Promise<string>;
  fetchWatched: () => Promise<string>;
  onStatus: () => void;
}

function Probe({ spies }: { spies: Spies }) {
  spies.render();
  // Default staleTime (0): a remount would refetch it; a reveal must not.
  const fresh = useQuery({ queryKey: ['fresh'], queryFn: spies.fetchFresh });
  // Kept until an event invalidates it.
  const watched = useQuery({
    queryKey: ['watched'],
    queryFn: spies.fetchWatched,
    staleTime: Infinity,
  });
  useRepoEvent('statusChanged', 1, spies.onStatus);
  return <span>{`${fresh.data ?? '…'} ${watched.data ?? '…'}`}</span>;
}

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount } },
  });
  let watched = 0;
  const spies = {
    render: vi.fn(),
    fetchFresh: vi.fn(() => Promise.resolve('fresh')),
    fetchWatched: vi.fn(() => Promise.resolve(`watched-${String(++watched)}`)),
    onStatus: vi.fn(),
  };
  const view = (visible: boolean) => (
    <QueryClientProvider client={client}>
      <Activity mode={visible ? 'visible' : 'hidden'}>
        <Root>
          <Probe spies={spies} />
        </Root>
      </Activity>
    </QueryClientProvider>
  );
  return { client, spies, view };
}

describe('hidden tab views', () => {
  it('do not render or fetch on events, and catch up only on what changed when shown', async () => {
    const { client, spies, view } = setup();
    const { rerender } = render(view(true));
    expect(await screen.findByText('fresh watched-1')).toBeInTheDocument();
    expect(spies.fetchFresh).toHaveBeenCalledTimes(1);

    rerender(view(false));
    const renders = spies.render.mock.calls.length;

    // Watcher event for the hidden repo, with the invalidation `useBackendEvents` makes.
    await act(async () => {
      mockBackend.emit('statusChanged', { repoId: 1 });
      await client.invalidateQueries({ queryKey: ['watched'] });
    });
    expect(spies.render).toHaveBeenCalledTimes(renders);
    expect(spies.fetchWatched).toHaveBeenCalledTimes(1);
    expect(spies.onStatus).not.toHaveBeenCalled();
    expect(mockBackend.events.listenerCount('statusChanged')).toBe(1); // the dirty counter only

    rerender(view(true));
    expect(await screen.findByText('fresh watched-2')).toBeInTheDocument();
    expect(spies.fetchWatched).toHaveBeenCalledTimes(2);
    expect(spies.fetchFresh).toHaveBeenCalledTimes(1);
    expect(spies.onStatus).toHaveBeenCalledTimes(1);

    // Shown again with nothing new: no fetch, no missed event replayed.
    rerender(view(false));
    rerender(view(true));
    await act(() => Promise.resolve());
    expect(spies.fetchWatched).toHaveBeenCalledTimes(2);
    expect(spies.fetchFresh).toHaveBeenCalledTimes(1);
    expect(spies.onStatus).toHaveBeenCalledTimes(1);

    // Visible: events are delivered as they come.
    act(() => {
      mockBackend.emit('statusChanged', { repoId: 1 });
      mockBackend.emit('statusChanged', { repoId: 2 });
    });
    expect(spies.onStatus).toHaveBeenCalledTimes(2);
  });

  it('fetch stale queries as usual on a first mount', async () => {
    const { client, spies, view } = setup();
    client.setQueryData(['fresh'], 'cached');
    render(view(true));
    expect(await screen.findByText('fresh watched-1')).toBeInTheDocument();
    expect(spies.fetchFresh).toHaveBeenCalledTimes(1);
  });
});
