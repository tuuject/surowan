import { useMutation } from '@tanstack/react-query';
import { Select } from '@tuuject/koi-react/select';
import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Label } from '@/components/ui/label';
import type { DictionaryExportFormat, DictionaryScope } from '@/lib/api/dictionary.ts';
import { fetchDictionaryExport } from '@/lib/api/dictionary.ts';
import { dictionaryErrorMessage } from '@/lib/dictionary.ts';
import { downloadTextFile } from '@/lib/download.ts';
import { toast } from '@/lib/toast.ts';
import { css } from '@tuuject/koi-react/styled-system/css';

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
}): React.ReactElement {
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
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
          <Label htmlFor="dictionary-export-format">{t('dictionary.export.formatLabel')}</Label>
          <Select
            id="dictionary-export-format"
            className={css({ width: '100%' })}
            aria-label={t('dictionary.export.formatLabel')}
            value={format}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'csv' || value === 'jsonl') {
                setFormat(value);
              }
            }}
          >
            <option value="csv">{t('dictionary.import.csv')}</option>
            <option value="jsonl">{t('dictionary.import.jsonl')}</option>
          </Select>
        </div>
        <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('dictionary.export.roundTripNote')}</p>
        {download.isError ? (
          <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
            {t('dictionary.export.failed')}: {dictionaryErrorMessage(download.error)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
