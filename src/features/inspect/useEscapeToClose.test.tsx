import { fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useEscapeToClose } from './useEscapeToClose';

afterEach(() => {
  document.body.innerHTML = '';
});

function escapeFrom(element: HTMLElement) {
  document.body.append(element);
  fireEvent.keyDown(element, { key: 'Escape' });
}

describe('useEscapeToClose', () => {
  it('closes from a read-only CodeMirror content, not from an editable one', () => {
    const onClose = vi.fn();
    renderHook(() => {
      useEscapeToClose(onClose);
    });
    // The gutter of a diff moves the focus to the read-only code (contenteditable="false").
    const readOnly = document.createElement('div');
    readOnly.setAttribute('contenteditable', 'false');
    escapeFrom(readOnly);
    expect(onClose).toHaveBeenCalledTimes(1);

    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    escapeFrom(editable);
    expect(onClose).toHaveBeenCalledTimes(1);

    const field = document.createElement('input');
    escapeFrom(field);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
