import { BlameView } from './BlameView';
import { FileHistoryView } from './FileHistoryView';
import type { InspectView as View } from './inspectStore';
import { LineHistoryView } from './LineHistoryView';
import { ReflogView } from './ReflogView';

/** The file history, line history, blame or reflog shown in place of the graph. */
export function InspectView({ repoId, view }: { repoId: number; view: View }) {
  switch (view.kind) {
    case 'fileHistory':
      return (
        <FileHistoryView
          key={`${view.path}@${view.rev ?? ''}`}
          repoId={repoId}
          path={view.path}
          rev={view.rev}
        />
      );
    case 'lineHistory':
      return (
        <LineHistoryView
          key={`${view.path}@${view.rev ?? ''}:${String(view.start)}-${String(view.end)}`}
          repoId={repoId}
          request={{ path: view.path, rev: view.rev, start: view.start, end: view.end }}
        />
      );
    case 'blame':
      return <BlameView repoId={repoId} target={view.target} trail={view.trail} />;
    case 'reflog':
      return <ReflogView key={view.reference} repoId={repoId} reference={view.reference} />;
  }
}
