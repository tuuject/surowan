import type React from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

/**
 * Requirements summary, the save error and the save button. The button refuses to mutate while `validationError`
 * names an unmet requirement, so the caller's mutation function never has to guess why it was not called.
 */
export function SaveActions({
  validationError,
  saveErrorText,
  savePending,
  onSave,
}: {
  readonly validationError: string | null;
  readonly saveErrorText: string | null;
  readonly savePending: boolean;
  readonly onSave: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <>
      {validationError && (
        <p id="image-save-requirements" role="status" className="text-sm text-muted-foreground">
          {validationError}
        </p>
      )}
      {saveErrorText !== null && (
        <p role="alert" className="text-destructive text-sm">
          {saveErrorText}
        </p>
      )}
      <Button
        onClick={() => {
          if (validationError !== null) {
            toast.error(validationError);
            return;
          }
          onSave();
        }}
        aria-describedby={validationError ? 'image-save-requirements' : undefined}
        disabled={savePending}
      >
        {savePending ? t('common.saving') : t('image.settings.saveAndApply')}
      </Button>
    </>
  );
}
