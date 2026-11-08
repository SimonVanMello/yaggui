import { create } from 'zustand';

import type { ErrorCode, OpKind, OpNote, OpOutcome } from '../../ipc';

export interface RunningOp {
  opId: number;
  repoId: number;
  kind: OpKind;
  cancellable: boolean;
  cancelRequested: boolean;
  phase: string | null;
  percent: number | null;
  /** Bytes transferred and rate, for network phases. */
  bytes: number | null;
  bytesPerSec: number | null;
}

export interface FinishedOp {
  opId: number;
  kind: OpKind;
  outcome: OpOutcome['kind'];
  /** Milliseconds since the epoch. */
  finishedAt: number;
  /**
   * Set by the backend when `success` does not mean "completed": a continue that halted on
   * the next `edit` (`paused`), or an abort (`aborted`). Git reports both as a success.
   */
  note?: OpNote;
  /** Code of the typed error of a `failed` outcome (status bar "Offline"). */
  errorCode?: ErrorCode;
}

/** Fetch, pull and push: their outcomes say whether the remotes could be reached. */
export function isNetworkKind(kind: OpKind): boolean {
  return kind === 'fetch' || kind === 'pull' || kind === 'push';
}

interface OpsStore {
  running: Record<number, RunningOp | undefined>;
  lastFinished: Record<number, FinishedOp | undefined>;
  /**
   * Last fetch, pull or push of each repository that was not cancelled, kept apart from
   * `lastFinished` so that a commit after it does not hide that the remotes were unreachable.
   */
  lastNetwork: Record<number, FinishedOp | undefined>;
  started: (
    op: Omit<RunningOp, 'phase' | 'percent' | 'bytes' | 'bytesPerSec' | 'cancelRequested'>,
  ) => void;
  progress: (
    opId: number,
    progress: Pick<RunningOp, 'phase' | 'percent' | 'bytes' | 'bytesPerSec'>,
  ) => void;
  /** `report: false` ends the operation without replacing the last result shown. */
  finished: (repoId: number, op: FinishedOp, report?: boolean) => void;
  cancelRequested: (opId: number) => void;
}

export const useOpsStore = create<OpsStore>()((set) => ({
  running: {},
  lastFinished: {},
  lastNetwork: {},
  started: (op) => {
    set((state) => ({
      running: {
        ...state.running,
        [op.opId]: {
          ...op,
          phase: null,
          percent: null,
          bytes: null,
          bytesPerSec: null,
          cancelRequested: false,
        },
      },
    }));
  },
  progress: (opId, progress) => {
    set((state) => {
      const op = state.running[opId];
      return op ? { running: { ...state.running, [opId]: { ...op, ...progress } } } : state;
    });
  },
  finished: (repoId, op, report = true) => {
    set((state) => {
      const running = Object.fromEntries(
        Object.entries(state.running).filter(([opId]) => Number(opId) !== op.opId),
      );
      // Recorded even when not reported: a pull stopped on conflicts did reach the remote.
      const lastNetwork =
        isNetworkKind(op.kind) && op.outcome !== 'cancelled'
          ? { ...state.lastNetwork, [repoId]: op }
          : state.lastNetwork;
      return report
        ? { running, lastNetwork, lastFinished: { ...state.lastFinished, [repoId]: op } }
        : { running, lastNetwork };
    });
  },
  cancelRequested: (opId) => {
    set((state) => {
      const op = state.running[opId];
      return op
        ? { running: { ...state.running, [opId]: { ...op, cancelRequested: true } } }
        : state;
    });
  },
}));

/** A closed repository forgets its last result: the status bar of a reopened one starts clean. */
export function forgetLastFinished(repoId: number): void {
  useOpsStore.setState((state) => {
    if (!(repoId in state.lastFinished) && !(repoId in state.lastNetwork)) return state;
    const without = <T>(record: Record<number, T>) =>
      Object.fromEntries(Object.entries(record).filter(([id]) => Number(id) !== repoId));
    return { lastFinished: without(state.lastFinished), lastNetwork: without(state.lastNetwork) };
  });
}

/** First running operation of a repository (operations are serialized per repo). */
export function selectRunningOp(repoId: number | null) {
  return (state: OpsStore): RunningOp | undefined =>
    repoId === null ? undefined : Object.values(state.running).find((op) => op?.repoId === repoId);
}
