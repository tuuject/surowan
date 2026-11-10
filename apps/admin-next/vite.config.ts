import path from 'node:path';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const ADMIN_API_TARGET = process.env.ADMIN_API_TARGET ?? 'http://127.0.0.1:8787';
const API_TARGET_ORIGIN = new URL(ADMIN_API_TARGET).origin;

// Only the two local dev origins may have their Origin rewritten to the API
// target. Anything else is left untouched so the backend origin check rejects
// it (server.ts compares the origin host with the forwarded Host host).
const ALLOWED_ORIGINS = ['http://localhost:5273', 'http://127.0.0.1:5273'];

export default defineConfig({
  plugins: [
    // Must come before react() so the generated route files are transformed by it.
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
  ],
  resolve: {
    // Keep the `@/` alias from tsconfig.json available in the dev server;
    // Rsbuild read tsconfig paths automatically, Vite needs the mapping here.
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: {
    port: 5273,
    // The API only accepts this origin; on another port every write is refused.
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      // `/api/` with the slash: a bare `/api` prefix also swallows the
      // `/api-keys` page route and serves the backend's 404 instead of the SPA.
      '/api/': {
        target: ADMIN_API_TARGET,
        // Forward the request with the target's host so Host and Origin agree.
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            const origin = req.headers.origin;
            if (origin !== undefined && ALLOWED_ORIGINS.includes(origin)) {
              proxyReq.setHeader('origin', API_TARGET_ORIGIN);
            }
          });
        },
      },
    },
  },
});
