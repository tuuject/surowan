import { useSyncExternalStore } from 'react';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastOptions {
  readonly description?: string;
}

export interface ToastItem {
  readonly id: number;
  readonly tone: ToastTone;
  readonly message: string;
  readonly description?: string;
}

const DURATION_MS = 4_000;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let nextId = 1;
let items: readonly ToastItem[] = [];

const emit = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  items = items.filter((item) => item.id !== id);
  emit();
}

function push(tone: ToastTone, message: string, options?: ToastOptions): number {
  const id = nextId++;
  items = [
    ...items,
    { id, tone, message, ...(options?.description === undefined ? {} : { description: options.description }) },
  ];
  timers.set(
    id,
    setTimeout(() => dismissToast(id), DURATION_MS),
  );
  emit();
  return id;
}

/**
 * Imperative Koi-styled toasts for the many mutation handlers that live
 * outside React. `<Toaster>` subscribes to this store and renders Koi's Toast
 * component; the three methods keep the call sites that used Sonner readable.
 */
export const toast = {
  success: (message: string, options?: ToastOptions) => push('success', message, options),
  error: (message: string, options?: ToastOptions) => push('error', message, options),
  info: (message: string, options?: ToastOptions) => push('info', message, options),
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): readonly ToastItem[] {
  return items;
}

export function useToasts(): readonly ToastItem[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
