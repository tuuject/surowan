import { css } from '@tuuject/koi-react/styled-system/css';
import { Toast } from '@tuuject/koi-react/toast';
import { useTranslation } from 'react-i18next';
import { useToasts } from '@/lib/toast';

/**
 * Bottom-center toast stack rendered with Koi's Toast. The provider-free store
 * in lib/toast lets mutation handlers call `toast.success(...)` without a
 * hook; this component is the single subscriber.
 *
 * The stack takes no pointer events and toasts have no close button: a
 * notification must never swallow a click on the page underneath. They dismiss
 * on the store's own timer.
 */
export function Toaster() {
  const { t } = useTranslation();
  const toasts = useToasts();

  return (
    <div
      role="region"
      aria-label={t('layout.koi.notifications')}
      className={css({
        position: 'fixed',
        insetInline: '0',
        bottom: '0',
        zIndex: 'toast',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '2',
        padding: '4',
        pointerEvents: 'none',
        '& *': { pointerEvents: 'none' },
      })}
    >
      {toasts.map((item) => (
        <div key={item.id} data-koi-toast="" data-tone={item.tone} className={css({ width: 'min(420px, 100%)' })}>
          <Toast
            tone={item.tone}
            title={item.message}
            {...(item.description === undefined ? {} : { description: item.description })}
          />
        </div>
      ))}
    </div>
  );
}
