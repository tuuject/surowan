/**
 * Display settings every screenshot is taken with, shared by the Playwright
 * config (which applies them) and the manifest (which records them). A change
 * here changes what the images prove, so it belongs in one place.
 */
export const DOCS_VIEWPORT = { width: 1440, height: 1000 } as const;

export const DOCS_DEVICE_SCALE_FACTOR = 1;
