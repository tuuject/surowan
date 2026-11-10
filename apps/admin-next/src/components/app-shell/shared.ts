// App-shell metrics. These are template chrome, not library sizes (the design system only owns
// component sizes); they stay below Koi's overlay layers (dialog 900 / popup 950 / toast 1000).
import { sizes, space } from '@tuuject/koi-tokens/dimensions';

export const SIDEBAR_WIDTH = '248px';
export const SIDEBAR_WIDTH_COLLAPSED = '72px';
/** Air above, below and between the header rows. */
export const HEADER_ROW_PADDING = '2';
/** A header row is exactly one control-md; the air around it belongs to the block. */
export const HEADER_ROW_HEIGHT = `${sizes['control-md']}px`;
/** One row plus its air on both sides: the header height in the sidebar layout. */
export const HEADER_HEIGHT = `${sizes['control-md'] + space['2'] * 2}px`;
/** Two rows with the same 8px above, between and below: the horizontal layout's header at md and up. */
export const HEADER_HEIGHT_HORIZONTAL = `${sizes['control-md'] * 2 + space['2'] * 3}px`;
/** Header rows and page content share this cap in the horizontal layout. */
export const CONTENT_MAX_WIDTH = '1280px';
/** Total height of the sticky header block, as a CSS variable set by AppShell. */
export const HEADER_OFFSET = '--app-header-offset';

// Safe area (defined from env() in globals.css). Rows on a window edge pad by max(own padding, inset).
export const SAFE_TOP = 'var(--app-safe-top)';
export const SAFE_RIGHT = 'var(--app-safe-right)';
export const SAFE_BOTTOM = 'var(--app-safe-bottom)';
export const SAFE_LEFT = 'var(--app-safe-left)';
export const TOP_ROW_CLEAR_LEFT = `max(${SAFE_LEFT}, var(--app-titlebar-inset-left))`;
export const TOP_ROW_CLEAR_RIGHT = `max(${SAFE_RIGHT}, calc(var(--app-titlebar-inset-right) + token(spacing.2)))`;
export const COLUMN_OFFSET = `max(0px, (100% - ${CONTENT_MAX_WIDTH}) / 2)`;

/**
 * `value` while a desktop shell draws window controls over the page (Electron's title-bar overlay, an installed
 * PWA's Window Controls Overlay), 0 otherwise. Kept in CSS so a desktop host changes the layout without remounting.
 */
export const withTitlebar = (value: string) => `min(calc(var(--app-titlebar-height) * 1000), ${value})`;
export const SIDEBAR_TITLEBAR_STRIP = 'min(calc(var(--app-titlebar-inset-left) * 1000), var(--app-titlebar-height))';
export const SIDEBAR_OUTER_WIDTH = `calc(${SIDEBAR_WIDTH} + ${SAFE_LEFT})`;
export const SIDEBAR_OUTER_WIDTH_COLLAPSED = `calc(${SIDEBAR_WIDTH_COLLAPSED} + ${SAFE_LEFT})`;
/** Height of the strip window controls are drawn in (0 without a desktop shell). */
export const TITLEBAR_HEIGHT = 'var(--app-titlebar-height)';
/** The sticky header block: below every Koi overlay, above the page. */
export const TOPBAR_Z_INDEX = 40;

/** Koi's keyboard focus outline (mirrors recipes/dimensions.ts focusRing; that helper isn't exported). */
export const focusRing = {
  outlineWidth: '2px',
  outlineStyle: 'solid',
  outlineColor: 'focus-ring',
  outlineOffset: '2px',
} as const;
