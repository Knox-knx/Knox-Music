import { create } from 'zustand';
import { uid } from '../core/utils';

export interface Toast { id: string; message: string; kind: 'success' | 'warn' | 'error' | 'info' }

interface ToastStore {
  toasts: Toast[];
  push: (message: string, kind?: Toast['kind']) => void;
  dismiss: (id: string) => void;
}

export const useToasts = create<ToastStore>((set) => ({
  toasts: [],
  push: (message, kind = 'success') => {
    const id = uid('toast');
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, message, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3400);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function toast(message: string, kind: Toast['kind'] = 'success') {
  useToasts.getState().push(message, kind);
}
