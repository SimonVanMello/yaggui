import { registerActions } from '../palette/actionRegistry';
import { useWorkspaceUi } from './workspaceStore';

/** Palette entries of the workspaces (F-006 to F-008). Returns the function removing them. */
export function registerWorkspaceActions(): () => void {
  return registerActions([
    {
      id: 'workspace.manage',
      title: 'palette.action.workspace.manage',
      group: 'repo',
      run: () => {
        useWorkspaceUi.getState().openManager(null);
      },
    },
    {
      id: 'workspace.scan',
      title: 'palette.action.workspace.scan',
      group: 'repo',
      run: () => {
        useWorkspaceUi.getState().openScan(null);
      },
    },
  ]);
}
