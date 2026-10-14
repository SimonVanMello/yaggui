import { create } from 'zustand';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  title: string;
  description?: string;
  /** Raw technical detail (Git stderr…), shown collapsed. */
  detail?: string;
  variant: ToastVariant;
  action?: ToastAction;
  /** Auto-dismiss delay in ms; errors stay until dismissed by default. */
  duration: number;
}

export type ToastInput = Omit<ToastItem, 'id' | 'variant' | 'duration'> &
  Partial<Pick<ToastItem, 'variant' | 'duration'>>;

const DEFAULT_DURATION = 5000;

interface ToastState {
  toasts: ToastItem[];
  show: (toast: ToastInput) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  show: (input) => {
    const id = nextId++;
    const variant = input.variant ?? 'info';
    const duration = input.duration ?? (variant === 'error' ? Infinity : DEFAULT_DURATION);
    set((state) => ({ toasts: [...state.toasts, { ...input, id, variant, duration }] }));
    return id;
  },
  dismiss: (id) => {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },
}));

/** Shows a toast from anywhere (components, query callbacks…). Returns its id. */
export function toast(input: ToastInput): number {
  return useToastStore.getState().show(input);
}
