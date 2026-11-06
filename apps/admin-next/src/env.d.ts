/// <reference types="vite/client" />

/**
 * Optional Koi browser globals used by a desktop shell or an embedding host.
 * The panel does not require them in a plain browser; the ThemeProvider is the
 * source of truth and mirrors the same `data-theme` / `koi-theme` contract.
 */
interface Window {
  koiSetTheme?: (theme: 'light' | 'dark' | null) => void;
  koiSetFont?: (font: 'chill' | null) => void;
  koiSetPalette?: (
    palette?: string | { primary: Record<string, string>; accent: Record<string, string> } | null,
  ) => void;
}
