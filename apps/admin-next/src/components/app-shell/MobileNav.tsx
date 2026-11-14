import { useRouterState } from '@tanstack/react-router';
import { Drawer } from '@tuuject/koi-react/drawer';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '@/stores/ui';
import { SidebarContent } from './SidebarContent';
import {
  SAFE_BOTTOM,
  SAFE_LEFT,
  SAFE_TOP,
  SIDEBAR_OUTER_WIDTH,
  SIDEBAR_TITLEBAR_STRIP,
  TITLEBAR_HEIGHT,
} from './shared';

/**
 * The navigation below md, as a drawer from the inline-start edge (right in RTL): the same brand and
 * list as the desktop sidebar. Koi's Drawer brings the backdrop, focus trap,
 * Esc, scroll lock and focus return; route changes close it through the
 * router subscription in main.tsx (back and forward count too).
 */
export function MobileNav() {
  const { t } = useTranslation();
  const open = useUiStore((state) => state.mobileNavOpen);
  const setMobileNavOpen = useUiStore((state) => state.setMobileNavOpen);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <Drawer
      open={open}
      onOpenChange={setMobileNavOpen}
      side="start"
      title={t('layout.mainNavigation')}
      hideTitle
      className={css({
        width: SIDEBAR_OUTER_WIDTH,
        paddingBlockStart: `max(${SAFE_TOP}, ${SIDEBAR_TITLEBAR_STRIP})`,
        paddingInlineStart: SAFE_LEFT,
        paddingInlineEnd: '0',
        paddingBlockEnd: SAFE_BOTTOM,
      })}
      classNames={{
        body: css({ padding: '0', overflow: 'hidden' }),
        close: css({ top: `calc(token(spacing.3) + ${SAFE_TOP})` }),
      }}
    >
      <SidebarContent pathname={pathname} onNavigate={() => setMobileNavOpen(false)} />
      {/* Desktop-shell title-bar strip: drags the window where the drawer covers the header. */}
      <div
        aria-hidden="true"
        data-app-region="drag"
        className={css({ position: 'absolute', top: 0, insetInline: 0, height: TITLEBAR_HEIGHT })}
      />
    </Drawer>
  );
}
