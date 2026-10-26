import { useEffect, useRef } from 'react';

import { modalOpen } from '../../app/shellActions';
import { matchShortcut } from '../../ui/shortcuts';

/** `Esc` outside fields, dialogs and menus calls `onClose` (back to the graph). */
export function useEscapeToClose(onClose: () => void, enabled = true): void {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matchShortcut(event, 'Escape')) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, [contenteditable="true"]')
      ) {
        return;
      }
      if (modalOpen() || document.querySelector('[role="menu"][data-state="open"]')) return;
      event.preventDefault();
      close.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [enabled]);
}
