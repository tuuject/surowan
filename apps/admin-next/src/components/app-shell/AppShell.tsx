import { Outlet } from '@tanstack/react-router';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useCloseMobileNavOnDesktop } from '@/hooks/use-close-mobile-nav-on-desktop';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useUiStore } from '@/stores/ui';
import { MobileNav } from './MobileNav';
import { Sidebar } from './Sidebar';
import {
  COLUMN_OFFSET,
  CONTENT_MAX_WIDTH,
  HEADER_HEIGHT,
  HEADER_HEIGHT_HORIZONTAL,
  HEADER_OFFSET,
  HEADER_ROW_PADDING,
  SAFE_BOTTOM,
  SAFE_LEFT,
  SAFE_RIGHT,
  SAFE_TOP,
  SIDEBAR_OUTER_WIDTH,
  SIDEBAR_OUTER_WIDTH_COLLAPSED,
  TOPBAR_Z_INDEX,
  withTitlebar,
} from './shared';
import { Topbar } from './Topbar';
import { TopNav } from './TopNav';

/**
 * The authenticated app chrome: a drawer below md, the sticky sidebar at md
 * and up, a sticky header and the routed content. Safe-area and title-bar
 * reservations stay in CSS so an installed PWA or a desktop shell can set them
 * without changing the DOM; browser tabs see every inset as zero.
 */
export function AppShell({ username, onSignOut }: { readonly username: string; readonly onSignOut: () => void }) {
  const navLayout = useUiStore((state) => state.navLayout);
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed);
  const sidebarMode = sidebarCollapsed ? 'rail' : 'full';
  const open = useUiStore((state) => state.mobileNavOpen);
  // Below md the drawer is the only navigation; mounting it only there keeps a closed dialog out of the DOM.
  const desktop = useMediaQuery('(min-width: 768px)');
  useCloseMobileNavOnDesktop(desktop);
  // An open drawer and its backdrop cover the header: the header stops dragging the window so a click there
  // reaches the backdrop and closes the drawer.
  const drawerOverHeader = open && !desktop;

  return (
    <div
      className={css({
        display: 'flex',
        minHeight: '100%',
        bg: 'page-bg',
        [HEADER_OFFSET]: `calc(${HEADER_HEIGHT} + ${SAFE_TOP})`,
        '&[data-nav-layout=horizontal]': {
          md: { [HEADER_OFFSET]: `calc(${HEADER_HEIGHT_HORIZONTAL} + ${SAFE_TOP})` },
        },
      })}
      data-nav-layout={navLayout}
    >
      {desktop ? <Sidebar /> : <MobileNav />}
      <div className={css({ display: 'flex', flexDirection: 'column', flex: '1', minWidth: '0' })}>
        {/* One sticky block: the horizontal layout stacks its nav row under the topbar, both pinned. */}
        <div
          data-app-region={drawerOverHeader ? undefined : 'drag'}
          className={css({
            position: 'sticky',
            top: 0,
            zIndex: TOPBAR_Z_INDEX,
            display: 'flex',
            flexDirection: 'column',
            gap: HEADER_ROW_PADDING,
            paddingBlockStart: `calc(token(spacing.${HEADER_ROW_PADDING}) + ${SAFE_TOP})`,
            paddingBlockEnd: HEADER_ROW_PADDING,
            bg: 'surface',
            borderBottomWidth: '1px',
            borderBottomStyle: 'solid',
            borderBottomColor: 'divider',
            md: {
              '&[data-sidebar]': { transition: 'margin-inline-start token(durations.fast) token(easings.out)' },
              '&[data-sidebar=full]': { marginInlineStart: `calc(-1 * ${withTitlebar(SIDEBAR_OUTER_WIDTH)})` },
              '&[data-sidebar=rail]': {
                marginInlineStart: `calc(-1 * ${withTitlebar(SIDEBAR_OUTER_WIDTH_COLLAPSED)})`,
              },
            },
          })}
          data-sidebar={navLayout === 'sidebar' ? sidebarMode : undefined}
        >
          <Topbar username={username} onSignOut={onSignOut} />
          {navLayout === 'horizontal' ? <TopNav /> : null}
        </div>
        <main
          className={css({
            flex: '1',
            minWidth: '0',
            paddingBlockStart: '4',
            paddingInlineStart: `max(token(spacing.4), ${SAFE_LEFT})`,
            paddingInlineEnd: `max(token(spacing.4), ${SAFE_RIGHT})`,
            paddingBlockEnd: `max(token(spacing.4), ${SAFE_BOTTOM})`,
            md: {
              paddingBlockStart: '6',
              paddingInlineStart: '6',
              paddingInlineEnd: `max(token(spacing.6), ${SAFE_RIGHT})`,
              paddingBlockEnd: `max(token(spacing.6), ${SAFE_BOTTOM})`,
            },
            '&[data-narrow=true]': {
              width: '100%',
              maxWidth: CONTENT_MAX_WIDTH,
              marginInline: 'auto',
              md: {
                paddingInlineStart: `max(token(spacing.6), calc(${SAFE_LEFT} - ${COLUMN_OFFSET}))`,
                paddingInlineEnd: `max(token(spacing.6), calc(${SAFE_RIGHT} - ${COLUMN_OFFSET}))`,
              },
            },
          })}
          data-narrow={navLayout === 'horizontal' || undefined}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
