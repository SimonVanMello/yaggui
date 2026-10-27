import { useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Local text of a field saved on blur or Enter, restarted from `value` whenever the stored
 * value changes under it (an import, or a save the backend normalized or refused): a blur
 * must not write the stale text back over what was just imported.
 */
export function useDraft(value: string): [string, Dispatch<SetStateAction<string>>] {
  const [draft, setDraft] = useState(value);
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setDraft(value);
  }
  return [draft, setDraft];
}
