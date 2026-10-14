/**
 * Pointer-based drag and drop (F-026, F-143).
 *
 * The HTML5 drag API is not used: Tauri takes over file drops on the window (`DropOverlay`), and
 * on Windows that disables HTML5 drag events inside the webview. Pointer events behave the same
 * on every platform and in the Playwright mock.
 *
 * A source calls `startPress` from `onPointerDown`. After a few pixels the drag begins; the
 * element under the pointer carrying `data-drop-branch` (and the same `data-drop-repo`) is the
 * drop target, highlighted with `data-drop-over`. Releasing on a target opens the drop menu.
 */
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { DragPayload } from '../dropActions';
import { useDragStore } from './dragStore';

const THRESHOLD_PX = 5;

export interface DragDescriptor {
  repoId: number;
  payload: DragPayload;
  label: string;
}

let active: (() => void) | null = null;

function targetAt(x: number, y: number, repoId: number): HTMLElement | null {
  const element = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-branch]');
  return element && element.dataset.dropRepo === String(repoId) ? element : null;
}

/** Cancels the drag in progress, if any (Esc, tab change). */
export function cancelDrag(): void {
  active?.();
}

/**
 * Starts tracking a press. Nothing happens until the pointer moved `THRESHOLD_PX`, so plain
 * clicks and double-clicks are untouched. `describe` runs when the drag begins (it may select
 * the pressed commit first).
 */
export function startPress(event: ReactPointerEvent, describe: () => DragDescriptor | null): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  cancelDrag();
  const startX = event.clientX;
  const startY = event.clientY;
  let descriptor: DragDescriptor | null = null;
  let started = false;
  let over: HTMLElement | null = null;

  const setOver = (next: HTMLElement | null) => {
    if (next === over) return;
    over?.removeAttribute('data-drop-over');
    next?.setAttribute('data-drop-over', 'true');
    over = next;
  };

  const finish = () => {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('keydown', onKey, true);
    setOver(null);
    delete document.body.dataset.dragging;
    useDragStore.getState().setDrag(null);
    active = null;
  };

  const cancel = () => {
    finish();
  };

  const suppressClick = () => {
    // The release after a drag would otherwise click the row it ends on.
    const swallow = (click: MouseEvent) => {
      click.stopPropagation();
      click.preventDefault();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    window.setTimeout(() => {
      window.removeEventListener('click', swallow, true);
    }, 0);
  };

  function onMove(move: PointerEvent) {
    if (!started) {
      if (Math.hypot(move.clientX - startX, move.clientY - startY) < THRESHOLD_PX) return;
      descriptor = describe();
      if (!descriptor) {
        finish();
        return;
      }
      started = true;
      document.body.dataset.dragging = 'true';
    }
    if (!descriptor) return;
    useDragStore.getState().setDrag({ ...descriptor, x: move.clientX, y: move.clientY });
    setOver(targetAt(move.clientX, move.clientY, descriptor.repoId));
  }

  function onUp(up: PointerEvent) {
    const dropped = started ? descriptor : null;
    const target = dropped ? targetAt(up.clientX, up.clientY, dropped.repoId) : null;
    const wasStarted = started;
    finish();
    if (wasStarted) suppressClick();
    if (dropped && target?.dataset.dropBranch) {
      useDragStore.getState().setMenu({
        repoId: dropped.repoId,
        payload: dropped.payload,
        target: target.dataset.dropBranch,
        x: up.clientX,
        y: up.clientY,
      });
    }
  }

  function onKey(key: KeyboardEvent) {
    if (key.key !== 'Escape') return;
    key.stopPropagation();
    key.preventDefault();
    if (started) suppressClick();
    finish();
  }

  active = cancel;
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', cancel, true);
  window.addEventListener('keydown', onKey, true);
}
