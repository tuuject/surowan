import { IconButton } from '@tuuject/koi-react/button';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useTranslation } from 'react-i18next';
import { MenuIcon, PanelLeftIcon, RowsIcon } from '@/components/icons';
import { useUiStore } from '@/stores/ui';
import { Brand } from './Brand';
import { Breadcrumbs } from './Breadcrumbs';
import { LanguageToggle } from './LanguageToggle';
import {
  COLUMN_OFFSET,
  CONTENT_MAX_WIDTH,
  HEADER_ROW_HEIGHT,
  TOP_ROW_CLEAR_LEFT,
  TOP_ROW_CLEAR_RIGHT,
  withTitlebar,
} from './shared';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

export function Topbar({ username, onSignOut }: { readonly username: string; readonly onSignOut: () => void }) {
  const { t } = useTranslation();
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed);
  const navLayout = useUiStore((state) => state.navLayout);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const setNavLayout = useUiStore((state) => state.setNavLayout);
  const setMobileNavOpen = useUiStore((state) => state.setMobileNavOpen);
  const horizontal = navLayout === 'horizontal';

  return (
    // The shell's sticky block paints the surface behind both rows.
    <header className={css({ display: 'flex' })}>
      <div
        data-narrow={horizontal || undefined}
        className={css({
          display: 'flex',
          alignItems: 'center',
          gap: '2',
          width: '100%',
          height: HEADER_ROW_HEIGHT,
          // The window's top strip: clear of cutouts and of window controls drawn over the page.
          paddingInlineStart: `max(token(spacing.4), ${TOP_ROW_CLEAR_LEFT})`,
          paddingInlineEnd: `max(token(spacing.4), ${TOP_ROW_CLEAR_RIGHT})`,
          md: { paddingInlineStart: `max(token(spacing.4), ${withTitlebar(TOP_ROW_CLEAR_LEFT)})` },
          '&[data-narrow=true]': {
            maxWidth: CONTENT_MAX_WIDTH,
            marginInline: 'auto',
            md: {
              paddingInlineStart: `max(token(spacing.6), calc(${TOP_ROW_CLEAR_LEFT} - ${COLUMN_OFFSET}))`,
              paddingInlineEnd: `max(token(spacing.6), calc(${TOP_ROW_CLEAR_RIGHT} - ${COLUMN_OFFSET}))`,
            },
          },
        })}
      >
        <IconButton
          icon={<MenuIcon size={16} />}
          label={t('layout.openNavigation')}
          size="sm"
          className={css({ display: 'flex', md: { display: 'none' } })}
          onClick={() => setMobileNavOpen(true)}
        />
        {horizontal ? (
          <>
            <div className={css({ display: 'none', md: { display: 'flex' } })}>
              <Brand compact />
            </div>
            <span
              aria-hidden="true"
              className={css({
                display: 'none',
                md: { display: 'block' },
                flexShrink: '0',
                width: '1px',
                height: '1rem',
                marginInline: '2',
                bg: 'divider',
              })}
            />
          </>
        ) : (
          <IconButton
            icon={<PanelLeftIcon size={16} />}
            label={sidebarCollapsed ? t('layout.expandSidebar') : t('layout.collapseSidebar')}
            size="sm"
            aria-expanded={!sidebarCollapsed}
            className={css({ display: 'none', md: { display: 'flex' } })}
            onClick={toggleSidebar}
          />
        )}
        <Breadcrumbs />
        <div className={css({ flex: '1' })} />
        <LanguageToggle />
        <ThemeToggle />
        <IconButton
          icon={horizontal ? <PanelLeftIcon size={16} /> : <RowsIcon size={16} />}
          label={horizontal ? t('layout.useSidebar') : t('layout.useHorizontalNav')}
          size="sm"
          className={css({ display: 'none', md: { display: 'flex' } })}
          onClick={() => setNavLayout(horizontal ? 'sidebar' : 'horizontal')}
        />
        <UserMenu username={username} onSignOut={onSignOut} />
      </div>
    </header>
  );
}
