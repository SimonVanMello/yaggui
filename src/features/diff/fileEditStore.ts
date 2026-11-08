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
  /** Files with unsaved edits, in an open editor or kept as a draft, by `editKey`. */
  unsaved: Readonly<Record<string, true>>;
}

export const useFileEditStore = create<FileEditStore>()(() => ({ editing: {}, unsaved: {} }));

const drafts = new Map<string, EditDraft>();
/** Open editors with unsaved edits (a closed one keeps them as a draft instead). */
const dirtyEditors = new Set<string>();

function refreshUnsaved(): void {
  const keys = [...new Set([...dirtyEditors, ...drafts.keys()])];
  const current = Object.keys(useFileEditStore.getState().unsaved);
  if (keys.length === current.length && keys.every((key) => current.includes(key))) return;
  useFileEditStore.setState({
    unsaved: Object.fromEntries(keys.map((key) => [key, true as const])),
  });
}

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
  dirtyEditors.delete(key);
  useFileEditStore.setState((state) => ({
    editing: Object.fromEntries(Object.entries(state.editing).filter(([k]) => k !== key)),
  }));
  refreshUnsaved();
}

/** Keeps unsaved edits for when the file's editor opens again. */
export function keepDraft(repoId: number, path: string, draft: EditDraft): void {
  const key = editKey(repoId, path);
  drafts.set(key, draft);
  // Now held by the draft: the editor is closing.
  dirtyEditors.delete(key);
  refreshUnsaved();
}

export function takeDraft(repoId: number, path: string): EditDraft | undefined {
  const key = editKey(repoId, path);
  const draft = drafts.get(key);
  drafts.delete(key);
  refreshUnsaved();
  return draft;
}

/** The open editor of the file has unsaved edits (or no longer has). */
export function setEditorDirty(repoId: number, path: string, dirty: boolean): void {
  const key = editKey(repoId, path);
  if (dirty) dirtyEditors.add(key);
  else dirtyEditors.delete(key);
  refreshUnsaved();
}

/** Splits an `editKey` back into its repository and path. */
export function parseEditKey(key: string): { repoId: number; path: string } {
  const separator = key.indexOf('\u0000');
  return { repoId: Number(key.slice(0, separator)), path: key.slice(separator + 1) };
}
