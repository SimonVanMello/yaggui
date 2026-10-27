import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '../../app/queryClient';
import { mockBackend } from '../../ipc/mockClient';
import { ScanDialog } from './ScanDialog';
import { createWorkspace, importRepos } from './workspaceOps';
import { useWorkspaceUi } from './workspaceStore';

vi.mock('./workspaceOps', () => ({
  createWorkspace: vi.fn(),
  importRepos: vi.fn(),
  pickFolder: vi.fn(() => Promise.resolve(null)),
}));

beforeEach(() => {
  mockBackend.reset();
  mockBackend.scanner.stepMs = 0;
  queryClient.clear();
  vi.mocked(createWorkspace).mockReset();
  vi.mocked(importRepos).mockReset();
  useWorkspaceUi.getState().openScan(null);
});

async function scanIntoNewWorkspace() {
  render(
    <QueryClientProvider client={queryClient}>
      <ScanDialog />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '/Users/alex/dev' } });
  fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
  await waitFor(() => {
    expect(screen.getByLabelText('Add to')).toBeInTheDocument();
  });
  fireEvent.change(screen.getByLabelText('Add to'), { target: { value: 'new' } });
  fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: 'Clients' } });
  fireEvent.click(screen.getByRole('button', { name: /^Import \d+ repositories$/ }));
}

describe('ScanDialog: import into a new workspace', () => {
  it('creates the workspace from the imported repos, after the import', async () => {
    const order: string[] = [];
    vi.mocked(importRepos).mockImplementation(() => {
      order.push('import');
      return Promise.resolve([3, 4]);
    });
    vi.mocked(createWorkspace).mockImplementation((name, repoIds) => {
      order.push('create');
      return Promise.resolve({ id: 9, name, repoIds: [...(repoIds ?? [])] });
    });
    await scanIntoNewWorkspace();
    await waitFor(() => {
      expect(createWorkspace).toHaveBeenCalledWith('Clients', [3, 4]);
    });
    expect(importRepos).toHaveBeenCalledWith(expect.any(Array), null);
    expect(order).toEqual(['import', 'create']);
    expect(useWorkspaceUi.getState().scan).toBeNull();
  });

  it('leaves no empty workspace behind when the import fails', async () => {
    vi.mocked(importRepos).mockResolvedValue(null);
    await scanIntoNewWorkspace();
    await waitFor(() => {
      expect(importRepos).toHaveBeenCalled();
    });
    expect(createWorkspace).not.toHaveBeenCalled();
    // The dialog stays open for a retry.
    expect(useWorkspaceUi.getState().scan).not.toBeNull();
  });
});
