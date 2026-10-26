import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useI18nStore } from '../../i18n/i18n';
import { ipc } from '../../ipc';
import { RemoveWorktreeDialog } from './RemoveWorktreeDialog';

afterEach(() => {
  useI18nStore.setState({ locale: 'en' });
});

describe('RemoveWorktreeDialog', () => {
  it('shows a failed preview in the UI language, with its suggested action', async () => {
    vi.spyOn(ipc.commands, 'worktreeRemovePreview').mockResolvedValue({
      status: 'error',
      error: {
        code: 'internal',
        message: { en: 'Not a repository', fr: 'Pas un dépôt' },
        action: { kind: 'retry' },
        detail: null,
        payload: null,
      },
    });
    useI18nStore.setState({ locale: 'fr' });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RemoveWorktreeDialog repoId={1} path="/tmp/wt" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Pas un dépôt')).toBeInTheDocument();
    expect(screen.queryByText('Not a repository')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument();
  });
});
