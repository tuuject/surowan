import { QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StringsProvider } from '@tuuject/koi-react';
import { type ReactNode, StrictMode, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import { AppDirectionProvider } from '@/components/app-direction';
import { ThemeProvider } from '@/components/themes/theme-provider';
import { Toaster } from '@/components/toaster';
import { getQueryClient } from '@/lib/query-client';
import { useUiStore } from '@/stores/ui';
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
const parseSearch = (searchString: string): Record<string, string> => {
  const search: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(searchString)) {
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

// Any page change closes the mobile drawer, including back / forward, which no click handler sees.
router.subscribe('onResolved', ({ pathChanged }) => {
  if (pathChanged) {
    useUiStore.getState().setMobileNavOpen(false);
  }
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

/** Koi's own component copy (close buttons, table placeholders, pagination) follows the active language too. */
function LocalizedKoi({ children }: { readonly children: ReactNode }) {
  const { t } = useTranslation();
  const strings = useMemo(
    () => ({
      close: t('layout.koi.close'),
      loading: t('layout.koi.loading'),
      processing: t('layout.koi.processing'),
      avatar: t('layout.koi.avatar'),
      optional: t('layout.koi.optional'),
      opensInNewWindow: t('layout.koi.opensInNewWindow'),
      prevPage: t('layout.koi.prevPage'),
      nextPage: t('layout.koi.nextPage'),
      pagination: t('layout.koi.pagination'),
      page: (page: number) => t('layout.koi.page', { page }),
      progress: t('layout.koi.progress'),
      inProgress: t('layout.koi.inProgress'),
      selectPlaceholder: t('layout.koi.selectPlaceholder'),
      search: t('layout.koi.search'),
      noMatches: t('layout.koi.noMatches'),
      remove: t('layout.koi.remove'),
      noData: t('layout.koi.noData'),
      notifications: t('layout.koi.notifications'),
      navMenu: t('layout.koi.navMenu'),
      breadcrumb: t('layout.koi.breadcrumb'),
      dropZone: t('layout.koi.dropZone'),
      dropZoneTitle: t('layout.koi.dropZoneTitle'),
      addEntry: t('layout.koi.addEntry'),
      addValue: t('layout.koi.addValue'),
      noEntries: t('layout.koi.noEntries'),
      noValues: t('layout.koi.noValues'),
      removeEntry: t('layout.koi.removeEntry'),
      removeValue: t('layout.koi.removeValue'),
      dragToReorder: t('layout.koi.dragToReorder'),
      sortableItem: t('layout.koi.sortableItem'),
      dragInstructions: t('layout.koi.dragInstructions'),
      dragPickedUp: (position: number) => t('layout.koi.dragPickedUp', { position }),
      dragMoved: (position: number) => t('layout.koi.dragMoved', { position }),
      dragDropped: (position: number) => t('layout.koi.dragDropped', { position }),
      dragCanceled: t('layout.koi.dragCanceled'),
      duplicateKey: t('layout.koi.duplicateKey'),
      duplicateValue: t('layout.koi.duplicateValue'),
    }),
    // react-i18next gives `t` a new identity on a language change.
    [t],
  );
  return <StringsProvider strings={strings}>{children}</StringsProvider>;
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('Admin root element is missing');
}

createRoot(container).render(
  <StrictMode>
    <AppDirectionProvider>
      <LocalizedKoi>
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
            <Toaster />
          </QueryClientProvider>
        </ThemeProvider>
      </LocalizedKoi>
    </AppDirectionProvider>
  </StrictMode>,
);
