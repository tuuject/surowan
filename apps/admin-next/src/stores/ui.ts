import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type NavLayout = 'sidebar' | 'horizontal';

interface UiState {
  /** Desktop sidebar collapsed to icons only. Persisted. Ignored in the horizontal layout. */
  sidebarCollapsed: boolean;
  /** Desktop navigation layout. Persisted; below md the drawer is always used. */
  navLayout: NavLayout;
  /** Mobile off-canvas navigation drawer. Never persisted. */
  mobileNavOpen: boolean;
  /**
   * Whether the Invocation pages follow the server's change stream. Persisted;
   * on by default, and a save from before the key existed reads as on because
   * `persist` merges the stored slice over this initial state.
   */
  invocationAutoRefresh: boolean;
  /** Whether the Invocation detail page scrolls to its bottom when new data arrives. Persisted; off by default. */
  invocationAutoScroll: boolean;
  toggleSidebar: () => void;
  setNavLayout: (layout: NavLayout) => void;
  setMobileNavOpen: (open: boolean) => void;
  setInvocationAutoRefresh: (autoRefresh: boolean) => void;
  setInvocationAutoScroll: (autoScroll: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      navLayout: 'sidebar',
      mobileNavOpen: false,
      invocationAutoRefresh: true,
      invocationAutoScroll: false,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setNavLayout: (layout) => set({ navLayout: layout }),
      setMobileNavOpen: (open) => set({ mobileNavOpen: open }),
      setInvocationAutoRefresh: (autoRefresh) => set({ invocationAutoRefresh: autoRefresh }),
      setInvocationAutoScroll: (autoScroll) => set({ invocationAutoScroll: autoScroll }),
    }),
    {
      name: 'surowan-admin-ui',
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        navLayout: state.navLayout,
        invocationAutoRefresh: state.invocationAutoRefresh,
        invocationAutoScroll: state.invocationAutoScroll,
      }),
    },
  ),
);
