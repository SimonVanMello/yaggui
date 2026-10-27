import { QueryClientProvider } from '@tanstack/react-query';
import { Tooltip } from 'radix-ui';

import { PrimitivesDemo } from '../features/demo/PrimitivesDemo';
import { DiffDemo } from '../features/diff/DiffDemo';
import { Toaster } from '../ui/Toaster';
import { ErrorBoundary } from './ErrorBoundary';
import { DragLayer } from '../features/history/dnd/DragLayer';
import { DropMenu } from '../features/history/dnd/DropMenu';
import { HistoryDialogs } from '../features/history/HistoryDialogs';
import { RefDialogs } from '../features/refs/RefDialogs';
import { CommitToolsDialogs } from '../features/staging/CommitToolsDialogs';
import { RemoteDialogs } from '../features/remotes/RemoteDialogs';
import { ConfirmDialog } from './errors/ConfirmDialog';
import { queryClient } from './queryClient';
import { Shell } from './Shell';
import { BranchToolsDialogs } from '../features/compare/BranchToolsDialogs';

/** `#primitives` shows the M0-1 primitives page, kept as a visual reference for `ui/`. */
const showPrimitives = window.location.hash === '#primitives';
/** `#diff-demo` (or `#diff-demo:/repo/path`) shows the M1-4 diff of HEAD without the graph. */
const diffDemo = /^#diff-demo(?::(.+))?$/.exec(window.location.hash);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* Non-hoverable tooltips close as soon as the pointer leaves: never two on screen. */}
      <Tooltip.Provider delayDuration={400} skipDelayDuration={200} disableHoverableContent>
        {/* The dialogs and the toaster are inside too: a render error anywhere shows the
            crash screen instead of unmounting the whole window. */}
        <ErrorBoundary>
          {showPrimitives ? (
            <PrimitivesDemo />
          ) : diffDemo ? (
            <DiffDemo path={diffDemo[1] ? decodeURIComponent(diffDemo[1]) : null} />
          ) : (
            <Shell />
          )}
          <ConfirmDialog />
          <RefDialogs />
          <RemoteDialogs />
          <HistoryDialogs />
          <CommitToolsDialogs />
          <BranchToolsDialogs />
          <DropMenu />
          <DragLayer />
          <Toaster />
        </ErrorBoundary>
      </Tooltip.Provider>
    </QueryClientProvider>
  );
}
