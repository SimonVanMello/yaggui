import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConfigEntry } from '../../ipc';
import { RawConfigEditor } from './RawConfigEditor';

const entry = (key: string, value: string | null = `${key}-value`): ConfigEntry => ({
  key,
  value,
});

const ENTRIES: ConfigEntry[] = [
  entry('core.editor'),
  entry('pull.rebase', 'true'),
  entry('user.name', 'Alex'),
  entry('user.email', 'alex@example.com'),
  entry('alias.co', 'checkout'),
];

// jsdom has no layout: give the virtualized list a size so that rows render.
const SIZES = { offsetWidth: 800, offsetHeight: 600 };
const originals = Object.fromEntries(
  Object.keys(SIZES).map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
  ]),
);

beforeEach(() => {
  for (const [name, value] of Object.entries(SIZES)) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
  }
});

afterEach(() => {
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
});

function renderEditor(entries: ConfigEntry[], onWrite = vi.fn(() => Promise.resolve(true))) {
  const view = render(
    <RawConfigEditor entries={entries} multiple={new Set()} scope="global" onWrite={onWrite} />,
  );
  return { ...view, onWrite };
}

describe('RawConfigEditor', () => {
  it('drops a pending edit when the entries change, instead of moving it to another key', () => {
    const { rerender, onWrite } = renderEditor(ENTRIES);
    fireEvent.click(screen.getByRole('button', { name: 'Edit user.email' }));
    const input = screen.getByRole('textbox', { name: 'Edit user.email' });
    fireEvent.change(input, { target: { value: 'new@example.com' } });

    // `pull.rebase` was removed: every row after it shifts by one.
    const after = ENTRIES.filter((e) => e.key !== 'pull.rebase');
    rerender(
      <RawConfigEditor entries={after} multiple={new Set()} scope="global" onWrite={onWrite} />,
    );

    expect(screen.queryByRole('textbox', { name: /^Edit / })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit alias.co' })).toBeEnabled();
    expect(onWrite).not.toHaveBeenCalled();
  });

  it('keeps the edit on its own key while the entries are the same', () => {
    const { onWrite } = renderEditor(ENTRIES);
    fireEvent.click(screen.getByRole('button', { name: 'Edit user.email' }));
    const input = screen.getByRole('textbox', { name: 'Edit user.email' });
    fireEvent.change(input, { target: { value: 'new@example.com' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onWrite).toHaveBeenCalledWith('user.email', 'new@example.com');
  });

  it('drops a pending removal when the entries change', () => {
    const { rerender, onWrite } = renderEditor(ENTRIES);
    fireEvent.click(screen.getByRole('button', { name: 'Remove user.name' }));
    expect(screen.getByRole('button', { name: 'Remove' })).toBeVisible();

    const after = ENTRIES.filter((e) => e.key !== 'core.editor');
    rerender(
      <RawConfigEditor entries={after} multiple={new Set()} scope="global" onWrite={onWrite} />,
    );

    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove user.email' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onWrite).toHaveBeenCalledWith('user.email', null);
  });

  it('tells apart the values of a key set several times', () => {
    const multi = [entry('remote.origin.fetch', 'a'), entry('remote.origin.fetch', 'b')];
    const { onWrite } = renderEditor(multi);
    const removes = screen.getAllByRole('button', { name: 'Remove remote.origin.fetch' });
    expect(removes).toHaveLength(2);
    fireEvent.click(removes[1] as HTMLElement);
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onWrite).toHaveBeenCalledWith('remote.origin.fetch', null);
  });
});
