import { defineConfig } from '@pandacss/dev';

/**
 * Koi ships its design system as a Panda preset plus build info; this app only
 * needs to point Panda at it. `include` covers our own `css()` calls in the
 * shell and shared layout components — the library's generated build info
 * already contains every utility its recipes can emit.
 */
export default defineConfig({
  preflight: true,
  designSystem: '@tuuject/koi-react',
  include: ['./src/**/*.{ts,tsx}'],
  outdir: 'styled-system',
});
