import { defineConfig } from '@pandacss/dev';

/**
 * Koi ships its design system as a Panda preset plus build info; this app only
 * points Panda at it. `include` covers every `css()` call in the app.
 */
export default defineConfig({
  preflight: true,
  designSystem: '@tuuject/koi-react',
  include: ['./src/**/*.{ts,tsx}'],
  outdir: 'styled-system',
  theme: {
    extend: {
      tokens: {
        fonts: {
          // Koi has only the `sans` family. The panel shows raw IDs, hashes, JSON
          // and diffs that need fixed-width glyphs, so it adds one app token
          // instead of writing a font stack at each call site.
          mono: { value: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace' },
        },
      },
    },
  },
});
