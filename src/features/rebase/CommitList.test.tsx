import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { useState } from 'react';

import type { InteractiveRebasePlan, RebasePlanCommit } from '../../ipc';
import { CommitList } from './CommitList';
import { initialRows, setAction, type RebaseRow } from './rebaseModel';

function commit(n: number): RebasePlanCommit {
  return {
    sha: String(n).repeat(40).slice(0, 40),
    summary: `c${String(n)}`,
    message: `c${String(n)}\n\nbody ${String(n)}`,
    authorName: 'Ada',
    authorEmail: 'ada@yaggui.dev',
    authorTime: 1_700_000_000 + n,
    merge: false,
    pushed: false,
  };
}

const plan: InteractiveRebasePlan = {
  base: { sha: '0'.repeat(40), summary: 'base' },
  head: commit(3).sha,
  branch: 'main',
  upstream: null,
  commits: [1, 2, 3].map(commit),
  hasMerges: false,
  pushed: 0,
};

function List() {
  const [rows, setRows] = useState<RebaseRow[]>(() => setAction(initialRows(plan), 2, 'reword'));
  return <CommitList rows={rows} onRows={setRows} upstream={null} label="Commits to rebase" />;
}

// jsdom has no pointer capture nor scrolling.
beforeAll(() => {
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => undefined;
});

describe('CommitList message editing', () => {
  it('lets rows be dragged again once the edited row is no longer reworded', async () => {
    const user = userEvent.setup();
    render(<List />);
    const reworded = screen.getByRole('option', { name: /c3/ });
    await user.click(within(reworded).getByRole('button', { name: 'Edit message' }));
    expect(screen.getByRole('textbox', { name: 'Commit summary' })).toBeInTheDocument();

    // "Pick" takes the message away, and the editor with it, without its own close.
    await user.click(within(reworded).getByRole('button', { name: 'Pick' }));
    expect(screen.queryByRole('textbox', { name: 'Commit summary' })).not.toBeInTheDocument();

    const other = screen.getByRole('option', { name: /c2/ });
    const grip = other.querySelector('[class*="grip"]') as HTMLElement;
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 10 });
    expect(other).toHaveAttribute('data-dragging', 'true');
  });
});
