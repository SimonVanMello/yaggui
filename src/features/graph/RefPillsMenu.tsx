import { useState, type ReactNode } from 'react';

import { ContextMenu } from '../../ui/ContextMenu';
import { RefContextMenu } from '../sidebar/RefContextMenu';
import { refTargetOf, type RefTarget } from '../sidebar/sidebarRows';
import { useRepoRefs } from '../sidebar/useRepoRefs';
import { useRepoState } from '../repo/useRepoState';
import { refOfEvent } from './refLabels';

/**
 * Ref labels outside the graph (commit details): a right click on a label opens the menu of
 * that ref, as in the graph and the sidebar (F-023). Elsewhere, no menu.
 */
export function RefPillsMenu({ repoId, children }: { repoId: number; children: ReactNode }) {
  const refs = useRepoRefs(repoId).data;
  const head = useRepoState(repoId).data?.head;
  const [target, setTarget] = useState<RefTarget | null>(null);

  const onContextMenuCapture = (event: React.MouseEvent) => {
    const label = refOfEvent(event);
    const next = label && refs ? refTargetOf(refs, label.kind, label.name) : null;
    if (!next) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    setTarget(next);
  };

  return (
    <ContextMenu
      content={
        target ? (
          <RefContextMenu
            repoId={repoId}
            target={target}
            current={head?.kind === 'branch' ? head.name : null}
          />
        ) : null
      }
    >
      <span onContextMenuCapture={onContextMenuCapture}>{children}</span>
    </ContextMenu>
  );
}
