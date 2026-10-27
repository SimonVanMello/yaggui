import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { DEFAULT_COLUMNS } from './columns';
import { GraphHeader } from './GraphHeader';

beforeAll(() => {
  // jsdom has no pointer capture.
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

function renderHeader() {
  const onChange = vi.fn();
  render(
    <GraphHeader
      columns={DEFAULT_COLUMNS}
      widths={{ graph: 200, author: 140, date: 124, sha: 76 }}
      onChange={onChange}
    />,
  );
  return { onChange, handle: screen.getByRole('separator', { name: 'Resize column Author' }) };
}

describe('GraphHeader resize handle', () => {
  it('resizes while the pointer is held', () => {
    const { onChange, handle } = renderHeader();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 80, pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ author: 160 }));
  });

  it('stops resizing after a cancelled drag, not only after pointerup', () => {
    const { onChange, handle } = renderHeader();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 60, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.lostPointerCapture(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 60, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });
});
