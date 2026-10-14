import { useEffect } from 'react';

import { findGlobalBinding, runBinding } from '../features/keybindings/registry';
import { isTerminalTarget, TERMINAL_PASSTHROUGH } from '../features/terminal/terminalFocus';
import { matchShortcut } from '../ui/shortcuts';
import { menuShortcuts } from './menu/appMenu';
import { bindingApplies, modalOpen } from './shellActions';

/** Global keyboard shortcuts (spec §5.15), as bound in the keybindings registry (F-281). */
export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.repeat && event.key !== 'Tab')) return;
      if (modalOpen()) return;
      // Once the macOS menu is installed, these are its accelerators: the menu runs them, and
      // handling them here too would run them twice (or keep the menu from seeing them).
      // Read at each key press: the menu is installed after this handler.
      for (const shortcut of menuShortcuts()) if (matchShortcut(event, shortcut)) return;
      const id = findGlobalBinding(event);
      // Undo and redo keys belong to a focused text field (and CodeMirror).
      if (id === null || !bindingApplies(id, event.target)) return;
      // A focused terminal gets every key (Ctrl+C, Ctrl+W…) but the palette and its own.
      if (isTerminalTarget(event.target) && !TERMINAL_PASSTHROUGH.includes(id)) {
        return;
      }
      event.preventDefault();
      runBinding(id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
