import { css, cx } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { EyeOffIcon } from '@/components/icons';
import { ToneBadge } from './state-badge';

/**
 * Marks assistant ordinary text as private reasoning. Assistant messages are
 * never published to Telegram on their own; only a successful `send` tool
 * call publishes a message. Used in the Agent transcript tab and the timeline.
 */

export function PrivateReasoningTag({ className }: { readonly className?: string }): ReactElement {
  const { t } = useTranslation();
  return (
    <ToneBadge tone="warning" {...(className !== undefined ? { className } : {})}>
      <EyeOffIcon className={css({ width: 'icon-xs', height: 'icon-xs' })} />
      {t('invocations.business.privateReasoning.tag')}
    </ToneBadge>
  );
}

export function PrivateReasoningNote({ className }: { readonly className?: string }): ReactElement {
  const { t } = useTranslation();
  return (
    <p className={cx(css({ textStyle: 'small', color: 'text-muted' }), className)}>
      {t('invocations.business.privateReasoning.note')}{' '}
      <code
        className={css({
          textStyle: 'small',
          borderRadius: 'lg',
          bg: 'surface-muted',
          paddingInline: '1',
          fontFamily: 'mono',
        })}
      >
        send
      </code>{' '}
      {t('invocations.business.privateReasoning.noteTail')}
    </p>
  );
}
