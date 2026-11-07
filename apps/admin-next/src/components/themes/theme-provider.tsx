import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

const THEME_KEY = 'admin-theme';

function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

/**
 * Applies both theme spellings the panel uses: Koi's Panda conditions read
 * `data-theme`, while the JSON viewer and existing persisted tooling read the
 * `dark` class. They always move together.
 */
function applyThemeClass(resolved: 'light' | 'dark') {
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.setAttribute('data-theme', resolved);
  root.style.colorScheme = resolved;
}

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === 'dark' || stored === 'light' || stored === 'system') {
        return stored;
      }
    } catch {
      // localStorage unavailable
    }
    return 'system';
  });

  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolveTheme(mode));

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      localStorage.setItem(THEME_KEY, next);
      // A desktop shell (Electron / installed PWA) may read the Koi-native
      // preference key to keep its own chrome in sync. `system` clears the
      // explicit choice, matching Koi's theme-init convention.
      if (next === 'system') {
        localStorage.removeItem('koi-theme');
      } else {
        localStorage.setItem('koi-theme', next);
      }
    } catch {
      // localStorage unavailable
    }
    const nextResolved = resolveTheme(next);
    setResolved(nextResolved);
    applyThemeClass(nextResolved);
  }, []);

  // Keep the attributes in sync with `resolved`: it changes with the mode and,
  // in "system" mode, with the OS scheme.
  useEffect(() => {
    applyThemeClass(resolved);
  }, [resolved]);

  // Optional host bridge: a desktop shell can call the Koi-native setter, and
  // the panel applies it through the same persisted mode as its own toggles.
  useEffect(() => {
    window.koiSetTheme = (theme) => setMode(theme ?? 'system');
    return () => {
      delete window.koiSetTheme;
    };
  }, [setMode]);

  // Listen for system theme changes when in "system" mode. The context value has
  // to follow, not just the DOM attributes: consumers such as the JSON viewer
  // read `resolved` and would otherwise keep the previous scheme.
  useEffect(() => {
    if (mode !== 'system') {
      return;
    }
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      const next = media.matches ? 'dark' : 'light';
      applyThemeClass(next);
      setResolved(next);
    };
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, [mode]);

  return <ThemeContext.Provider value={{ mode, resolved, setMode }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return context;
}
