import { useMutation } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Field } from '@tuuject/koi-react/field';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DictionaryExportFormat, DictionaryScope } from '@/lib/api/dictionary.ts';
import { fetchDictionaryExport } from '@/lib/api/dictionary.ts';
import { dictionaryErrorMessage } from '@/lib/dictionary.ts';
import { downloadTextFile } from '@/lib/download.ts';
import { toast } from '@/lib/toast.ts';

/**
 * Export dialog for the scope the page is currently showing. The API answers
 * the file body as text; the download is assembled client-side so the request
 * still travels through the same-origin fetch wrapper and its error reporting.
 */
export function ExportDialog({
  open,
  onOpenChange,
  scope,
  chatId,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly scope: DictionaryScope;
  readonly chatId: string | null;
}): ReactElement {
  const { t } = useTranslation();
  const [format, setFormat] = useState<DictionaryExportFormat>('csv');

  const download = useMutation({
    mutationFn: () => fetchDictionaryExport({ scope, chat: chatId, format }),
    onSuccess: (file) => {
      downloadTextFile(file.filename, file.text);
      toast.success(t('dictionary.export.downloaded', { name: file.filename }));
      onOpenChange(false);
    },
  });

  // Base UI keeps the popup mounted while it fades out, so this component and
  // its mutation outlive a session. The state is replaced on the open edge —
  // a render-phase adjustment, the app's substitute for a reset effect — and
  // never on close, so the form stays on screen through the exit transition.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      download.reset();
      setFormat('csv');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && download.isPending) {
          return;
        }
        onOpenChange(next);
      }}
      title={t('dictionary.export.title')}
      description={t('dictionary.export.description')}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            color="secondary"
            disabled={download.isPending}
            onClick={() => onOpenChange(false)}
          >
            {t('common.cancel')}
          </Button>
          <Button type="button" disabled={download.isPending} onClick={() => download.mutate()}>
            {download.isPending ? t('common.working') : t('dictionary.export.download')}
          </Button>
        </>
      }
    >
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
        <Field label={t('dictionary.export.formatLabel')} help={t('dictionary.export.roundTripNote')}>
          <Select
            value={format}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'csv' || value === 'jsonl') {
                setFormat(value);
              }
            }}
            options={[
              { value: 'csv', label: t('dictionary.import.csv') },
              { value: 'jsonl', label: t('dictionary.import.jsonl') },
            ]}
          />
        </Field>
        {download.isError ? (
          <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
            {t('dictionary.export.failed')}：{dictionaryErrorMessage(download.error)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
