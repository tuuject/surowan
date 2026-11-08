import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useTranslation } from 'react-i18next';
import type { ChatThinkingReset } from '@/lib/api/models.ts';

/** The per-Chat efforts an Agent model switch reset, shown once after the switch. */
export function ThinkingResetDialog({
  resets,
  onClose,
}: {
  readonly resets: readonly ChatThinkingReset[];
  readonly onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <Dialog
      open={resets.length > 0}
      onOpenChange={(open) => !open && onClose()}
      title={t('models.models.page.chatThinkingResetTitle')}
      description={t('models.models.page.chatThinkingResetDescription')}
      footer={<Button onClick={onClose}>{t('models.models.page.chatThinkingResetClose')}</Button>}
    >
      <ul
        className={css({
          textStyle: 'body',
          maxHeight: '256px',
          '& > :not(:last-child)': { marginBlockEnd: '2' },
          overflowY: 'auto',
        })}
      >
        {resets.map((reset) => (
          <li key={reset.chat_id}>
            <code>{reset.chat_id}</code>: {reset.previous} → {reset.current}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
