import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { mockBackend } from '../../ipc/mockClient';
import { useConfigWriter } from './useGitConfig';

beforeEach(() => {
  mockBackend.reset();
});

describe('useConfigWriter', () => {
  it('refreshes the default pull strategy shown on the Pull button', async () => {
    const client = new QueryClient();
    client.setQueryData(['pullDefaultStrategy', 1, null], 'ffOnly');
    client.setQueryData(['git-identity', 1], { name: 'a', email: 'b' });
    const { result } = renderHook(() => useConfigWriter('global', null), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });

    await expect(result.current('pull.rebase', 'true')).resolves.toBe(true);

    expect(client.getQueryState(['pullDefaultStrategy', 1, null])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['git-identity', 1])?.isInvalidated).toBe(true);
  });
});
