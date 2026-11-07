import { useRouterState } from '@tanstack/react-router';
import { NavMenu } from '@tuuject/koi-react/nav-menu';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useTranslation } from 'react-i18next';
import { activeNavValue } from '@/nav';
import { COLUMN_OFFSET, CONTENT_MAX_WIDTH, HEADER_ROW_HEIGHT, SAFE_LEFT, SAFE_RIGHT } from './shared';
import { useNavMenu } from './use-nav-menu';

/**
 * Desktop horizontal navigation: row two of the shell header, below the
 * topbar. Hidden below md, where the sidebar drawer is the only navigation.
 * It shares the topbar's centered column and scrolls sideways if the items
 * outgrow it rather than widening the column.
 */
export function TopNav() {
  const { t } = useTranslation();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { sections, onSelect } = useNavMenu();

  return (
    <div
      className={css({
        display: 'none',
        width: '100%',
        maxWidth: CONTENT_MAX_WIDTH,
        marginInline: 'auto',
        height: HEADER_ROW_HEIGHT,
        md: {
          display: 'flex',
          paddingInlineStart: `max(token(spacing.6), calc(${SAFE_LEFT} - ${COLUMN_OFFSET}))`,
          paddingInlineEnd: `max(token(spacing.6), calc(${SAFE_RIGHT} - ${COLUMN_OFFSET}))`,
        },
      })}
    >
      <NavMenu
        orientation="horizontal"
        sections={sections}
        value={activeNavValue(pathname)}
        label={t('layout.mainNavigation')}
        onSelect={onSelect}
        className={css({ padding: '0' })}
      />
    </div>
  );
}
