import { isTextEntry } from '../../ui/textEntry';

/**
 * macOS: the Edit menu owns ⌘Z, so a text field no longer receives it. When the focus is in
 * one, hands the command back to the field: a synthetic key press for CodeMirror (its own
 * history), the editing command for native inputs. Returns whether the field took it.
 */
export function forwardToTextEntry(
  command: 'undo' | 'redo',
  target: Element | null = document.activeElement,
): boolean {
  if (!target || !isTextEntry(target)) return false;
  if (target.closest('.cm-editor')) {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        code: 'KeyZ',
        metaKey: true,
        shiftKey: command === 'redo',
        bubbles: true,
        cancelable: true,
      }),
    );
  } else {
    // No replacement exists for the undo stack of a native input; this is the macOS menu path only.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    document.execCommand(command);
  }
  return true;
}
