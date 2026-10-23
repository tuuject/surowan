import { useMutation } from '@tanstack/react-query';
import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

import { dictionaryErrorMessage, downloadTextFile } from '@/lib/dictionary.ts';
import { fetchDictionaryExport } from '@/lib/api/dictionary.ts';
import type { DictionaryExportFormat, DictionaryScope } from '@/lib/api/dictionary.ts';

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
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('dictionary.export.title')}</DialogTitle>
          <DialogDescription>{t('dictionary.export.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="dictionary-export-format">{t('dictionary.export.formatLabel')}</Label>
            <Select
              value={format}
              onValueChange={(value) => {
                if (value === 'csv' || value === 'jsonl') {
                  setFormat(value);
                }
              }}
            >
              <SelectTrigger
                id="dictionary-export-format"
                className="w-full"
                aria-label={t('dictionary.export.formatLabel')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="csv">{t('dictionary.import.csv')}</SelectItem>
                <SelectItem value="jsonl">{t('dictionary.import.jsonl')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-muted-foreground text-xs">{t('dictionary.export.roundTripNote')}</p>
          {download.isError ? (
            <p className="text-destructive text-sm break-words">
              {t('dictionary.export.failed')}: {dictionaryErrorMessage(download.error)}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={download.isPending} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="button" disabled={download.isPending} onClick={() => download.mutate()}>
            {download.isPending ? t('common.working') : t('dictionary.export.download')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
