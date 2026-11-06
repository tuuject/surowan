import { css } from '@tuuject/koi-react/styled-system/css';
import { Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const logo = css({
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 'control-lg',
  height: 'control-lg',
  borderRadius: 'xl',
  bg: 'primary-solid',
  color: 'on-primary-solid',
});

const logoCompact = css({
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 'control-md',
  height: 'control-md',
  borderRadius: 'xl',
  bg: 'primary-solid',
  color: 'on-primary-solid',
});

const title = css({ textStyle: 'heading-3', fontWeight: 'bold', color: 'text', whiteSpace: 'nowrap' });
const titleCompact = css({ textStyle: 'body', fontWeight: 'bold', color: 'text', whiteSpace: 'nowrap' });

/**
 * The product mark: a 44px logo box in the sidebar, a 36px one when it sits in the topbar next to the
 * breadcrumbs. The subtitle is sidebar-only; the topbar has no room for it.
 */
export function Brand({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={css({ display: 'flex', alignItems: 'center', gap: '3', minWidth: '0' })}>
      <span className={compact ? logoCompact : logo} aria-hidden="true">
        <Zap size={compact ? 18 : 22} />
      </span>
      <span
        className={css({ display: 'flex', flexDirection: 'column', gap: '0.125rem', minWidth: '0' })}
        data-brand-text
      >
        <span className={compact ? titleCompact : title}>{t('brand.name')}</span>
        {compact ? null : (
          <span className={css({ textStyle: 'small', color: 'text-muted' })}>{t('brand.adminTitle')}</span>
        )}
      </span>
    </div>
  );
}
