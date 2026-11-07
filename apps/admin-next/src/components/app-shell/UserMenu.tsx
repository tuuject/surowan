import { useNavigate } from '@tanstack/react-router';
import { Avatar } from '@tuuject/koi-react/avatar';
import { Menu } from '@tuuject/koi-react/menu';
import { css } from '@tuuject/koi-react/styled-system/css';
import { ChevronDownIcon } from '@tuuject/koi-react/icons';
import { LogoutIcon, SlidersIcon } from '@/components/icons';
import { useTranslation } from 'react-i18next';
import { focusRing } from './shared';

/**
 * User dropdown in the topbar: Koi's Menu, so the panel is the same one
 * NavMenu's flyouts use. The trigger keeps the shell's avatar/name/chevron
 * anatomy.
 */
export function UserMenu({ username, onSignOut }: { readonly username: string; readonly onSignOut: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <Menu
      placement="bottom-end"
      trigger={
        <button
          type="button"
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '2',
            height: 'control-md',
            paddingInlineStart: '1',
            paddingInlineEnd: '3',
            borderRadius: 'full',
            cursor: 'pointer',
            transitionProperty: 'background-color',
            transitionDuration: 'fast',
            _hover: { bg: 'surface-muted' },
            _focusVisible: focusRing,
            '&[data-popup-open]': { bg: 'surface-muted' },
          })}
          aria-label={t('layout.userMenu')}
        >
          <Avatar name={username} size="sm" />
          <span
            className={css({
              textStyle: 'body',
              color: 'text',
              display: { base: 'none', md: 'inline' },
              whiteSpace: 'nowrap',
            })}
          >
            {username}
          </span>
          <ChevronDownIcon
            size={14}
            className={css({
              color: 'text-muted',
              display: { base: 'none', md: 'flex' },
              transition: 'transform token(durations.check) token(easings.spring)',
              '[data-popup-open] > &': { transform: 'rotate(180deg)' },
            })}
          />
        </button>
      }
      header={
        <div className={css({ display: 'flex', alignItems: 'center', gap: '3' })}>
          <Avatar name={username} size="md" />
          <span className={css({ textStyle: 'body', fontWeight: 'bold', color: 'text' })}>{username}</span>
        </div>
      }
      items={[
        { value: 'settings', label: t('layout.nav.settings'), icon: <SlidersIcon size={16} /> },
        { value: 'logout', label: t('layout.misc.signOut'), icon: <LogoutIcon size={16} /> },
      ]}
      onSelect={(value) => {
        if (value === 'settings') {
          void navigate({ to: '/settings' });
          return;
        }
        onSignOut();
      }}
    />
  );
}
