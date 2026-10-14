import { create } from 'zustand';

/** A configured remote as the dialogs edit it. */
export interface RemoteDraft {
  name: string;
  url: string | null;
  pushUrl: string | null;
}

/** Remote dialogs (M4-7c); one at a time, rendered by `RemoteDialogs`. */
export type RemoteDialog =
  | { kind: 'manage'; repoId: number }
  | {
      kind: 'edit';
      repoId: number;
      /** `null`: a new remote. */
      remote: RemoteDraft | null;
      /** Opened from the manage dialog: closing goes back to it. */
      fromManage: boolean;
    };

interface RemoteDialogsStore {
  dialog: RemoteDialog | null;
  open: (dialog: RemoteDialog) => void;
  close: () => void;
}

export const useRemoteDialogs = create<RemoteDialogsStore>()((set) => ({
  dialog: null,
  open: (dialog) => {
    set({ dialog });
  },
  close: () => {
    set({ dialog: null });
  },
}));

export function openRemoteDialog(dialog: RemoteDialog): void {
  useRemoteDialogs.getState().open(dialog);
}

/** Closes the dialog, back to the manage dialog when it was opened from there. */
export function leaveRemoteDialog(): void {
  const { dialog, open, close } = useRemoteDialogs.getState();
  if (dialog?.kind === 'edit' && dialog.fromManage) open({ kind: 'manage', repoId: dialog.repoId });
  else close();
}
