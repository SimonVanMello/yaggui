import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { selectedLines, usePublishedLines, type LineRange } from './lineSelection';

const range: LineRange = { path: 'src/a.ts', rev: 'abc', start: 3, end: 7 };

describe('selected lines', () => {
  it('are published while the view has them, and cleared on unmount', () => {
    const view = renderHook(
      ({ lines }) => {
        usePublishedLines(4, lines);
      },
      { initialProps: { lines: null as LineRange | null } },
    );
    expect(selectedLines(4)).toBeNull();
    view.rerender({ lines: range });
    expect(selectedLines(4)).toEqual(range);
    view.rerender({ lines: null });
    expect(selectedLines(4)).toBeNull();
    view.rerender({ lines: range });
    view.unmount();
    expect(selectedLines(4)).toBeNull();
  });

  it('belong to the last view that selected lines; another clearing leaves them', () => {
    const first = renderHook(() => {
      usePublishedLines(5, range);
    });
    const other = { ...range, start: 10, end: 10 };
    const second = renderHook(() => {
      usePublishedLines(5, other);
    });
    expect(selectedLines(5)).toEqual(other);
    act(() => {
      first.unmount();
    });
    expect(selectedLines(5)).toEqual(other);
    second.unmount();
    expect(selectedLines(5)).toBeNull();
  });
});
