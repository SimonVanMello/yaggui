import { create } from 'zustand';

import type { DragPayload } from '../dropActions';

/** A drag in progress: what is carried, where the pointer is. */
export interface ActiveDrag {
  repoId: number;
  payload: DragPayload;
  /** Text shown next to the pointer. */
  label: string;
  x: number;
  y: number;
}

/** Menu shown where a drag was released on a branch. */
export interface DropMenuState {
  repoId: number;
  payload: DragPayload;
  /** Local branch released on. */
  target: string;
  x: number;
  y: number;
}

interface DragStore {
  drag: ActiveDrag | null;
  menu: DropMenuState | null;
  setDrag: (drag: ActiveDrag | null) => void;
  setMenu: (menu: DropMenuState | null) => void;
}

export const useDragStore = create<DragStore>()((set) => ({
  drag: null,
  menu: null,
  setDrag: (drag) => {
    set({ drag });
  },
  setMenu: (menu) => {
    set({ menu });
  },
}));
