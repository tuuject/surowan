import { useMutation, useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ScopePicker } from '@/components/dictionary/entry-form.tsx';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  type DictionaryChatOption,
  type DictionaryDraft,
  type DictionaryExportFormat,
  type DictionaryImportPreview,
  type DictionaryScope,
  importDictionaryEntries,
  previewDictionaryImport,
} from '@/lib/api.ts';
import { dictionaryErrorMessage } from '@/lib/dictionary.ts';

/**
 * Import flow: pick a CSV/JSONL file or paste content, ask the server for a
 * parsed preview, review the normalized entries and any conflicts, then write.
 * Parsing is server-side on purpose — the alias grammar (`|`, `\|`, `\\`) has
 * exactly one implementation. Nothing is persisted before the confirm click,
 * and the write creates new entries instead of overwriting by name.
 */
export function ImportDialog({
  open,
  onOpenChange,
  chats,
  defaultScope,
  defaultChatId,
  onImported,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly chats: readonly DictionaryChatOption[];
  readonly defaultScope: DictionaryScope;
  readonly defaultChatId: string | null;
  readonly onImported: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileId = useId();
  const contentId = useId();
  const [format, setFormat] = useState<DictionaryExportFormat>('csv');
  const [scope, setScope] = useState<DictionaryScope>(defaultScope);
  const [chatId, setChatId] = useState<string | null>(defaultChatId);
  const [content, setContent] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<DictionaryImportPreview | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const reset = (): void => {
    setContent('');
    setFileName(null);
    setPreview(null);
    setReadError(null);
  };

  const previewMutation = useMutation({
    mutationFn: () =>
      previewDictionaryImport({
        format,
        content,
        scope,
        chat_id: scope === 'global' ? null : chatId,
      }),
    onSuccess: (result) => {
      setPreview(result);
    },
  });

  const importMutation = useMutation({
    mutationFn: (entries: readonly DictionaryDraft[]) => importDictionaryEntries(entries),
    onSuccess: (result) => {
      toast.success(t('dictionary.import.imported', { count: result.items.length }));
      void queryClient.invalidateQueries({ queryKey: ['dictionary'] });
      reset();
      onImported();
      onOpenChange(false);
    },
    onError: () => {
      // The dialog stays open so the parsed preview and the error are both visible.
      void queryClient.invalidateQueries({ queryKey: ['dictionary'] });
    },
  });

  const targetChatId = scope === 'global' ? null : chatId;
  const draftEntries = (preview?.entries ?? []).map((entry) => ({
    ...entry,
    scope,
    chat_id: targetChatId,
  }));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && (importMutation.isPending || previewMutation.isPending)) {
          return;
        }
        if (!next) {
          reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('dictionary.import.title')}</DialogTitle>
          <DialogDescription>{t('dictionary.import.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`${fileId}-format`}>{t('dictionary.import.formatLabel')}</Label>
              <Select
                value={format}
                onValueChange={(value) => {
                  if (value === 'csv' || value === 'jsonl') {
                    setFormat(value);
                    setPreview(null);
                  }
                }}
              >
                <SelectTrigger
                  id={`${fileId}-format`}
                  className="w-full"
                  aria-label={t('dictionary.import.formatLabel')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="csv">{t('dictionary.import.csv')}</SelectItem>
                  <SelectItem value="jsonl">{t('dictionary.import.jsonl')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={fileId}>{t('dictionary.import.fileLabel')}</Label>
              <Input
                id={fileId}
                type="file"
                accept={format === 'csv' ? '.csv,text/csv' : '.jsonl,.json,application/jsonl'}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file === undefined) {
                    return;
                  }
                  setReadError(null);
                  setPreview(null);
                  void file
                    .text()
                    .then((text) => {
                      setContent(text);
                      setFileName(file.name);
                    })
                    .catch(() => {
                      setReadError(t('dictionary.import.fileFailed'));
                    });
                }}
              />
              {fileName !== null ? (
                <p className="text-muted-foreground text-xs">
                  {t('dictionary.import.fileLoaded', { name: fileName, chars: String(content.length) })}
                </p>
              ) : null}
              {readError !== null ? <p className="text-destructive text-sm">{readError}</p> : null}
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t('dictionary.import.scopeLabel')}</Label>
            <ScopePicker
              scope={scope}
              chatId={chatId}
              chats={chats}
              idPrefix={`${fileId}-scope`}
              onChange={(nextScope, nextChatId) => {
                setScope(nextScope);
                setChatId(nextChatId);
                setPreview(null);
              }}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={contentId}>{t('dictionary.import.pasteLabel')}</Label>
            <Textarea
              id={contentId}
              rows={5}
              className="font-mono text-xs"
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                setFileName(null);
                setPreview(null);
              }}
            />
          </div>

          {content.trim().length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('dictionary.import.contentRequired')}</p>
          ) : null}
          {previewMutation.isError ? (
            <p className="text-destructive text-sm break-words">
              {t('dictionary.import.previewFailed')}: {dictionaryErrorMessage(previewMutation.error)}
            </p>
          ) : null}

          {preview !== null ? (
            <div className="space-y-3">
              <p className="font-medium">{t('dictionary.import.previewTitle', { count: preview.entries.length })}</p>
              {preview.entries.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t('dictionary.import.previewEmpty')}</p>
              ) : (
                <div className="max-h-64 overflow-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1 text-left font-medium">{t('dictionary.page.colTerm')}</th>
                        <th className="px-2 py-1 text-left font-medium">{t('dictionary.page.colDefinition')}</th>
                        <th className="px-2 py-1 text-left font-medium">{t('dictionary.page.colAliases')}</th>
                        <th className="px-2 py-1 text-left font-medium">{t('dictionary.page.colEnabled')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.entries.map((entry, index) => (
                        <tr key={`${entry.term}-${String(index)}`} className="border-t align-top">
                          <td className="px-2 py-1 font-medium">{entry.term}</td>
                          <td className="max-w-80 px-2 py-1 whitespace-normal">{entry.definition}</td>
                          <td className="px-2 py-1">{entry.aliases.length === 0 ? '—' : entry.aliases.join(' | ')}</td>
                          <td className="px-2 py-1">
                            {entry.enabled ? t('dictionary.page.enabledOn') : t('dictionary.page.enabledOff')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="space-y-1">
                <p className="font-medium">
                  {t('dictionary.import.conflictsTitle', { count: preview.conflicts.length })}
                </p>
                {preview.conflicts.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t('dictionary.import.conflictsNone')}</p>
                ) : (
                  <ul className="text-sm">
                    {preview.conflicts.map((conflict) => (
                      <li key={conflict.value} className="font-mono text-xs break-all">
                        {conflict.value}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-muted-foreground text-xs">{t('dictionary.import.conflictsNote')}</p>
              </div>
              <p className="text-muted-foreground text-xs">{t('dictionary.import.previewNote')}</p>
            </div>
          ) : null}

          {importMutation.isError ? (
            <p className="text-destructive text-sm break-words">{dictionaryErrorMessage(importMutation.error)}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={importMutation.isPending || previewMutation.isPending}
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            {t('dictionary.import.cancel')}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={content.trim().length === 0 || previewMutation.isPending || importMutation.isPending}
            onClick={() => previewMutation.mutate()}
          >
            {previewMutation.isPending ? t('dictionary.import.previewing') : t('dictionary.import.preview')}
          </Button>
          <Button
            type="button"
            disabled={
              preview === null || draftEntries.length === 0 || importMutation.isPending || previewMutation.isPending
            }
            onClick={() => importMutation.mutate(draftEntries)}
          >
            {importMutation.isPending
              ? t('dictionary.import.importing')
              : t('dictionary.import.confirm', { count: draftEntries.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
