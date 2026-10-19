import { create } from 'zustand';

/** Unsaved text of a file editor that was closed (another file, back to the graph). */
export interface EditDraft {
  text: string;
  /** Version of the file on disk the edits started from. */
  version: string;
}

interface FileEditStore {
  /** Files shown in their editor rather than their diff, by `editKey`. */
  editing: Readonly<Record<string, true>>;
}

export const useFileEditStore = create<FileEditStore>()(() => ({ editing: {} }));

const drafts = new Map<string, EditDraft>();

export function editKey(repoId: number, path: string): string {
  return `${String(repoId)}\u0000${path}`;
}

export function useEditing(repoId: number, path: string): boolean {
  return useFileEditStore((state) => state.editing[editKey(repoId, path)] === true);
}

export function startEditing(repoId: number, path: string): void {
  const key = editKey(repoId, path);
  useFileEditStore.setState((state) => ({ editing: { ...state.editing, [key]: true } }));
}

/** Back to the diff; unsaved edits are dropped. */
export function stopEditing(repoId: number, path: string): void {
  const key = editKey(repoId, path);
  drafts.delete(key);
  useFileEditStore.setState((state) => ({
    editing: Object.fromEntries(Object.entries(state.editing).filter(([k]) => k !== key)),
  }));
}

/** Keeps unsaved edits for when the file's editor opens again. */
export function keepDraft(repoId: number, path: string, draft: EditDraft): void {
  drafts.set(editKey(repoId, path), draft);
}

export function takeDraft(repoId: number, path: string): EditDraft | undefined {
  const key = editKey(repoId, path);
  const draft = drafts.get(key);
  drafts.delete(key);
  return draft;
}
