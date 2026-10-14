import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { useTabsStore } from '../../app/tabs/tabsStore';
import type { RepoState } from '../../ipc';
import { BranchSelector } from './BranchSelector';

const STATE: RepoState = {
  head: { kind: 'branch', name: 'main', oid: '0123456789abcdef0123456789abcdef01234567' },
  upstream: null,
  dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  operation: null,
  indexLock: null,
};

function setup() {
  const tab = useTabsStore.getState().tabs[0];
  if (!tab) throw new Error('no tab');
  render(
    <QueryClientProvider client={new QueryClient()}>
      <button type="button">outside</button>
      <BranchSelector tab={tab} repoId={1} state={STATE} />
    </QueryClientProvider>,
  );
  return { trigger: screen.getByRole('button', { name: /main/ }) };
}

describe('BranchSelector', () => {
  it('closes on an outside click', async () => {
    const user = userEvent.setup();
    const { trigger } = setup();
    await user.click(trigger);
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('closes on Escape and gives the focus back to the trigger', async () => {
    const user = userEvent.setup();
    const { trigger } = setup();
    await user.click(trigger);
    expect(screen.getByRole('combobox')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
