import { useSyncExternalStore } from 'react';

/**
 * Display preferences that belong to one browser, not to the deployment:
 * they live in localStorage and never reach the server or config.jsonc.
 */
const SHOW_CONFIG_KEYS_KEY = 'admin-show-config-keys';

const listeners = new Set<() => void>();

function readShowConfigKeys(): boolean {
  try {
    return localStorage.getItem(SHOW_CONFIG_KEYS_KEY) === 'true';
  } catch {
    // localStorage unavailable
    return false;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab changing the preference updates this one too.
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export function setShowConfigKeys(show: boolean): void {
  try {
    if (show) {
      localStorage.setItem(SHOW_CONFIG_KEYS_KEY, 'true');
    } else {
      localStorage.removeItem(SHOW_CONFIG_KEYS_KEY);
    }
  } catch {
    // localStorage unavailable: the switch reverts to the stored value
  }
  for (const listener of listeners) {
    listener();
  }
}

/** Whether settings pages show the config.jsonc path of each field; off by default. */
export function useShowConfigKeys(): boolean {
  return useSyncExternalStore(subscribe, readShowConfigKeys, () => false);
}
