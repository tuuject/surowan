import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/business';

/**
 * Asked before a model switch that would stop running Invocations: the global
 * Agent model on the Models and Providers pages, and a Chat's own model on the
 * Chats page. The caller keeps it mounted and drives `open`, so the count stays
 * on screen while the exit transition plays.
 */
export function ModelSwitchConfirmDialog({
  open,
  count,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  readonly open: boolean;
  /** Running Invocations the switch stops. */
  readonly count: number;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onCancel();
        }
      }}
      title={t('models.models.switchConfirm.title')}
      description={t('models.models.switchConfirm.description', { count })}
      confirmText={t('models.models.switchConfirm.confirm')}
      cancelText={t('common.cancel')}
      destructive
      pending={pending}
      error={error}
      onConfirm={onConfirm}
    />
  );
}
