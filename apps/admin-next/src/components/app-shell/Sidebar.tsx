import { useRouterState } from '@tanstack/react-router';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useUiStore } from '@/stores/ui';
import { SidebarContent } from './SidebarContent';
import {
  HEADER_HEIGHT,
  SAFE_BOTTOM,
  SAFE_LEFT,
  SAFE_TOP,
  SIDEBAR_OUTER_WIDTH,
  SIDEBAR_OUTER_WIDTH_COLLAPSED,
  TOPBAR_Z_INDEX,
  withTitlebar,
} from './shared';

/**
 * The desktop navigation: the shell's first flex column, pinned to the
 * viewport from md up. Below md the mobile drawer is the navigation, so the
 * aside is not rendered there at all.
 */
export function Sidebar() {
  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const navLayout = useUiStore((state) => state.navLayout);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <aside
      className={css({
        display: 'none',
        md: {
          display: 'flex',
          flexDirection: 'column',
          position: 'sticky',
          top: 0,
          alignSelf: 'flex-start',
          height: '100dvh',
          width: SIDEBAR_OUTER_WIDTH,
          zIndex: TOPBAR_Z_INDEX - 1,
          paddingBlockStart: `calc(${SAFE_TOP} + ${withTitlebar(`calc(${HEADER_HEIGHT} + 1px)`)})`,
          paddingInlineStart: SAFE_LEFT,
          paddingBlockEnd: SAFE_BOTTOM,
          bg: 'surface',
          borderRightWidth: '1px',
          borderRightStyle: 'solid',
          borderRightColor: 'divider',
          transition: 'width token(durations.fast) token(easings.out)',
          '&[data-nav-layout=horizontal]': { display: 'none' },
          '&[data-collapsed=true]': { width: SIDEBAR_OUTER_WIDTH_COLLAPSED },
        },
      })}
      data-collapsed={collapsed}
      data-nav-layout={navLayout}
    >
      <SidebarContent pathname={pathname} rail={collapsed} />
    </aside>
  );
}
