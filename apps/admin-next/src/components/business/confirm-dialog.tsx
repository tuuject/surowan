import { Dialog } from '@tuuject/koi-react/dialog';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@tuuject/koi-react/button';
import { css } from '@tuuject/koi-react/styled-system/css';

/**
 * Confirmation dialog for destructive / control operations. The dialog never
 * auto-closes on confirm: the caller closes it (`open=false`) on success or
 * cancel. `pending` disables both buttons (no double submits) and `error`
 * shows the ApiError text inline.
 *
 * `confirmText` and the dismiss label must stay distinguishable; mismatches
 * are rejected at render time.
 */
export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: React.ReactNode;
  readonly confirmText: string;
  readonly cancelText?: string;
  readonly destructive?: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  cancelText,
  destructive = false,
  pending,
  error,
  onConfirm,
}: ConfirmDialogProps): React.ReactElement {
  const { t } = useTranslation();
  const dismissLabel = cancelText ?? t('common.dismiss');
  if (confirmText.trim().length === 0 || dismissLabel.trim().length === 0) {
    throw new Error('ConfirmDialog: confirmText and cancelText must be non-empty');
  }
  if (confirmText === dismissLabel) {
    throw new Error(
      `ConfirmDialog: confirmText ("${confirmText}") must differ from the dismiss label ("${dismissLabel}")`,
    );
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) {
          return;
        }
        onOpenChange(next);
      }}
      role="alertdialog"
      size="sm"
      title={title}
      {...(description !== undefined ? { description } : {})}
      hideClose
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            color="secondary"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {dismissLabel}
          </Button>
          <Button
            type="button"
            color={destructive ? 'error' : 'primary'}
            loading={pending}
            loadingLabel={t('common.working')}
            onClick={onConfirm}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      {error !== null ? (
        <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>{error}</p>
      ) : null}
    </Dialog>
  );
}
