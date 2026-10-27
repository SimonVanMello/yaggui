import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tooltip } from 'radix-ui';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ipc, type Blame, type BlameCommit } from '../../ipc';
import { BlameView } from './BlameView';
import { inspectViewOf } from './inspectStore';

function commit(n: number, previous: BlameCommit['previous']): BlameCommit {
  return {
    sha: String(n).repeat(40).slice(0, 40),
    authorName: 'Ada',
    authorEmail: 'ada@yaggui.dev',
    authorTime: 1_700_000_000 + n,
    summary: `c${String(n)}`,
    path: 'a.ts',
    previous,
    uncommitted: false,
  };
}

// Commit 1 owns two chunks: lines 0–2 (from its line 0) and lines 5–7 (from its line 40).
const blame: Blame = {
  path: 'a.ts',
  rev: '1'.repeat(40),
  content: {
    kind: 'text',
    lines: Array.from({ length: 10 }, (_, i) => `line ${String(i + 1)}`),
    encoding: 'utf8',
    commits: [commit(1, { sha: '9'.repeat(40), path: 'a.ts' }), commit(2, null)],
    chunks: [
      { start: 0, count: 3, commit: 0, sourceStart: 0 },
      { start: 3, count: 2, commit: 1, sourceStart: 3 },
      { start: 5, count: 3, commit: 0, sourceStart: 40 },
      { start: 8, count: 2, commit: 1, sourceStart: 8 },
    ],
  },
};

// jsdom lays nothing out: the virtualized lines need a height to render.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 600,
  });
});

describe('BlameView', () => {
  it('blames the parent from the clicked line, not the first line of the commit', async () => {
    vi.spyOn(ipc.commands, 'blame').mockResolvedValue({ status: 'ok', data: blame });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Tooltip.Provider>
          <BlameView repoId={7} target={{ path: 'a.ts', rev: blame.rev }} trail={[]} />
        </Tooltip.Provider>
      </QueryClientProvider>,
    );
    const rows = await screen.findAllByRole('row');
    await user.click(rows[6] as HTMLElement);
    await user.click(screen.getByRole('button', { name: 'Blame of the parent' }));
    const view = inspectViewOf(7);
    expect(view?.kind === 'blame' && view.target).toEqual({
      path: 'a.ts',
      rev: '9'.repeat(40),
      line: 40,
    });
  });
});
