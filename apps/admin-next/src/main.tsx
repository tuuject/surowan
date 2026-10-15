import { QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@/components/themes/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { getQueryClient } from '@/lib/query-client';
import { routeTree } from './routeTree.gen';

// Side-effect import: initializes i18next (sync, resources inline) before any
// component renders.
import '@/lib/i18n';

import '@/styles/globals.css';

const queryClient = getQueryClient();

/**
 * Plain query-string semantics for search params: every value round-trips as
 * a string. The default TanStack serialization JSON-encodes/decodes values,
 * which turns a deep link like `?chat=123456789` into a number and re-writes
 * filtered URLs as `?chat=%22123456789%22`. All panel search params are flat
 * strings, so keep them readable.
 */
const parseSearch = (searchStr: string): Record<string, string> => {
  const search: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(searchStr)) {
    search[key] = value;
  }
  return search;
};

const stringifySearch = (search: Record<string, unknown>): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }
  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : '';
};

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  parseSearch,
  stringifySearch,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('Admin root element is missing');
}

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <Toaster />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
