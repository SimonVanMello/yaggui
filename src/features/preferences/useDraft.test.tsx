import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { currentPreferences, loadPreferences, updatePreferences } from '../../app/preferences';
import { queryClient } from '../../app/queryClient';
import { ipc } from '../../ipc';
import { mockBackend } from '../../ipc/mockClient';
import { DisplaySection } from './DisplaySection';
import { GitPathField } from './GitPathField';
import { SyncSection } from './SyncSection';
import { ToolsSection } from './ToolsSection';
import { useDraft } from './useDraft';

beforeEach(async () => {
  mockBackend.reset();
  queryClient.clear();
  await loadPreferences();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const withQueries = (ui: React.ReactElement) =>
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

describe('useDraft', () => {
  it('keeps what was typed until the stored value changes', () => {
    const { result, rerender } = renderHook(({ value }) => useDraft(value), {
      initialProps: { value: 'a' },
    });
    act(() => {
      result.current[1]('typed');
    });
    rerender({ value: 'a' });
    expect(result.current[0]).toBe('typed');
    rerender({ value: 'b' });
    expect(result.current[0]).toBe('b');
  });
});

describe('text fields follow an import while the dialog is open', () => {
  it('Fetch and pull: the minutes field shows the imported value and a blur keeps it', async () => {
    withQueries(<SyncSection />);
    const minutes = screen.getByLabelText('Every (minutes)');
    expect(minutes).toHaveValue('10');

    await act(() => updatePreferences({ autoFetchMinutes: 5 }));
    expect(minutes).toHaveValue('5');

    fireEvent.focus(minutes);
    fireEvent.blur(minutes);
    expect(currentPreferences().autoFetchMinutes).toBe(5);
    await expect(ipc.commands.getPreferences()).resolves.toMatchObject({
      data: { autoFetchMinutes: 5 },
    });
  });

  it('Display: the font fields and the text size follow the stored value', async () => {
    withQueries(<DisplaySection />);
    await act(() =>
      updatePreferences({ uiFont: 'Fira Sans', codeFont: 'Fira Code', fontSize: 15 }),
    );
    expect(screen.getByLabelText('Interface font')).toHaveValue('Fira Sans');
    expect(screen.getByLabelText('Code font')).toHaveValue('Fira Code');
    expect(screen.getByLabelText('Text size')).toHaveValue('15');
    fireEvent.blur(screen.getByLabelText('Interface font'));
    expect(currentPreferences().uiFont).toBe('Fira Sans');
  });

  it('Tools: the editor field follows the stored value', async () => {
    withQueries(<ToolsSection />);
    await act(() => updatePreferences({ editor: 'code' }));
    expect(screen.getByLabelText('Editor')).toHaveValue('code');
    fireEvent.blur(screen.getByLabelText('Editor'));
    expect(currentPreferences().editor).toBe('code');
  });

  it('Git: the path field follows the stored value', async () => {
    withQueries(<GitPathField />);
    await act(() => updatePreferences({ gitPath: '/opt/homebrew/bin/git' }));
    expect(screen.getByLabelText('Git binary')).toHaveValue('/opt/homebrew/bin/git');
  });
});

describe('text size slider', () => {
  it('saves once after a drag, with the last value', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(ipc.commands, 'setPreferences');
    withQueries(<DisplaySection />);
    const slider = screen.getByLabelText('Text size');
    fireEvent.change(slider, { target: { value: '14' } });
    fireEvent.change(slider, { target: { value: '15' } });
    fireEvent.change(slider, { target: { value: '16' } });
    expect(slider).toHaveValue('16');
    expect(spy).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ fontSize: 16 });
    expect(currentPreferences().fontSize).toBe(16);
  });
});
