import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tooltip } from 'radix-ui';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChangedFile } from '../../ipc';
import { ChangedFileList, type FileListStaging } from './ChangedFileList';

function file(path: string): ChangedFile {
  return {
    path,
    oldPath: null,
    status: 'modified',
    additions: 1,
    deletions: 0,
    similarity: null,
    binary: false,
    oldMode: 'regular',
    newMode: 'regular',
  };
}

const files = [file('a.ts'), file('b.ts'), file('c.ts')];

// jsdom lays nothing out: the virtualized list needs a height to render its rows.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 600,
  });
});

function deferred() {
  let resolve: (value: boolean) => void = () => undefined;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(onDiscard: FileListStaging['onDiscard']) {
  const onSelect = vi.fn();
  const staging: FileListStaging = {
    list: 'unstaged',
    onToggle: () => Promise.resolve(true),
    onToggleAll: () => undefined,
    onDiscard,
    onDrop: () => undefined,
  };
  render(
    <Tooltip.Provider>
      <ChangedFileList
        title="Changes"
        files={files}
        selectedPath="a.ts"
        onSelect={onSelect}
        staging={staging}
      />
    </Tooltip.Provider>,
  );
  return { onSelect };
}

describe('ChangedFileList actions on the open file', () => {
  it('moves to the next file only once the action succeeded', async () => {
    const user = userEvent.setup();
    const pending = deferred();
    const { onSelect } = setup(() => pending.promise);
    const row = screen.getByRole('option', { name: /a\.ts/ });
    await user.click(row.querySelector('button[aria-label="Discard changes"]') as HTMLElement);
    // The confirmation is up: the diff stays on the file it may discard.
    expect(onSelect).not.toHaveBeenCalled();
    pending.resolve(true);
    await vi.waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith(files[1]);
    });
  });

  it('stays on the file when the action is cancelled or fails', async () => {
    const user = userEvent.setup();
    const { onSelect } = setup(() => Promise.resolve(false));
    const row = screen.getByRole('option', { name: /a\.ts/ });
    await user.click(row.querySelector('button[aria-label="Discard changes"]') as HTMLElement);
    await new Promise((done) => setTimeout(done, 0));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
