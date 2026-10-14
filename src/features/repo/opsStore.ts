import { create } from 'zustand';

import type { OpKind, OpNote, OpOutcome } from '../../ipc';

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
}

interface OpsStore {
  running: Record<number, RunningOp | undefined>;
  lastFinished: Record<number, FinishedOp | undefined>;
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
      return report
        ? { running, lastFinished: { ...state.lastFinished, [repoId]: op } }
        : { running };
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

/** First running operation of a repository (operations are serialized per repo). */
export function selectRunningOp(repoId: number | null) {
  return (state: OpsStore): RunningOp | undefined =>
    repoId === null ? undefined : Object.values(state.running).find((op) => op?.repoId === repoId);
}
