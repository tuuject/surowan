import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Select } from '@tuuject/koi-react/select';
import type React from 'react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScopePicker } from '@/components/dictionary/entry-form.tsx';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Input } from '@tuuject/koi-react/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@tuuject/koi-react/textarea';
import type {
  DictionaryChatOption,
  DictionaryDraft,
  DictionaryExportFormat,
  DictionaryImportPreview,
  DictionaryScope,
} from '@/lib/api/dictionary.ts';
import { importDictionaryEntries, previewDictionaryImport } from '@/lib/api/dictionary.ts';
import { dictionaryErrorMessage } from '@/lib/dictionary.ts';
import { toast } from '@/lib/toast.ts';
import { css } from '@tuuject/koi-react/styled-system/css';

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
      title={t('dictionary.import.title')}
      description={t('dictionary.import.description')}
      size="lg"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            color="secondary"
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
            color="secondary"
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
        </>
      }
    >
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
        <div className={css({ display: 'grid', gap: '3', md: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } })}>
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
            <Label htmlFor={`${fileId}-format`}>{t('dictionary.import.formatLabel')}</Label>
            <Select
              id={`${fileId}-format`}
              className={css({ width: '100%' })}
              aria-label={t('dictionary.import.formatLabel')}
              value={format}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'csv' || value === 'jsonl') {
                  setFormat(value);
                  setPreview(null);
                }
              }}
            >
              <option value="csv">{t('dictionary.import.csv')}</option>
              <option value="jsonl">{t('dictionary.import.jsonl')}</option>
            </Select>
          </div>
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
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
              <p className={css({ textStyle: 'small', color: 'text-muted' })}>
                {t('dictionary.import.fileLoaded', { name: fileName, chars: String(content.length) })}
              </p>
            ) : null}
            {readError !== null ? <p className={css({ textStyle: 'body', color: 'error-text' })}>{readError}</p> : null}
          </div>
        </div>

        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
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

        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
          <Label htmlFor={contentId}>{t('dictionary.import.pasteLabel')}</Label>
          <Textarea
            id={contentId}
            rows={5}
            className={css({ textStyle: 'small', fontFamily: 'mono' })}
            value={content}
            onChange={(event) => {
              setContent(event.target.value);
              setFileName(null);
              setPreview(null);
            }}
          />
        </div>

        {content.trim().length === 0 ? (
          <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('dictionary.import.contentRequired')}</p>
        ) : null}
        {previewMutation.isError ? (
          <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
            {t('dictionary.import.previewFailed')}: {dictionaryErrorMessage(previewMutation.error)}
          </p>
        ) : null}

        {preview !== null ? (
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
            <p className={css({ textStyle: 'label' })}>
              {t('dictionary.import.previewTitle', { count: preview.entries.length })}
            </p>
            {preview.entries.length === 0 ? (
              <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('dictionary.import.previewEmpty')}</p>
            ) : (
              <div
                className={css({
                  maxHeight: '256px',
                  overflow: 'auto',
                  borderRadius: 'lg',
                  borderWidth: '1px',
                  borderColor: 'border',
                })}
              >
                <table className={css({ textStyle: 'body', width: '100%' })}>
                  <thead className={css({ bg: 'surface-muted', color: 'text-muted' })}>
                    <tr>
                      <th
                        className={css({
                          textStyle: 'label',
                          paddingInline: '2',
                          paddingBlock: '1',
                          textAlign: 'start',
                        })}
                      >
                        {t('dictionary.page.colTerm')}
                      </th>
                      <th
                        className={css({
                          textStyle: 'label',
                          paddingInline: '2',
                          paddingBlock: '1',
                          textAlign: 'start',
                        })}
                      >
                        {t('dictionary.page.colDefinition')}
                      </th>
                      <th
                        className={css({
                          textStyle: 'label',
                          paddingInline: '2',
                          paddingBlock: '1',
                          textAlign: 'start',
                        })}
                      >
                        {t('dictionary.page.colAliases')}
                      </th>
                      <th
                        className={css({
                          textStyle: 'label',
                          paddingInline: '2',
                          paddingBlock: '1',
                          textAlign: 'start',
                        })}
                      >
                        {t('dictionary.page.colEnabled')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.entries.map((entry, index) => (
                      <tr
                        key={`${entry.term}-${String(index)}`}
                        className={css({ borderTopWidth: '1px', borderColor: 'divider', verticalAlign: 'top' })}
                      >
                        <td className={css({ textStyle: 'label', paddingInline: '2', paddingBlock: '1' })}>
                          {entry.term}
                        </td>
                        <td
                          className={css({
                            maxWidth: '320px',
                            paddingInline: '2',
                            paddingBlock: '1',
                            whiteSpace: 'normal',
                          })}
                        >
                          {entry.definition}
                        </td>
                        <td className={css({ paddingInline: '2', paddingBlock: '1' })}>
                          {entry.aliases.length === 0 ? '—' : entry.aliases.join(' | ')}
                        </td>
                        <td className={css({ paddingInline: '2', paddingBlock: '1' })}>
                          {entry.enabled ? t('dictionary.page.enabledOn') : t('dictionary.page.enabledOff')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
              <p className={css({ textStyle: 'label' })}>
                {t('dictionary.import.conflictsTitle', { count: preview.conflicts.length })}
              </p>
              {preview.conflicts.length === 0 ? (
                <p className={css({ textStyle: 'body', color: 'text-muted' })}>
                  {t('dictionary.import.conflictsNone')}
                </p>
              ) : (
                <ul className={css({ textStyle: 'body' })}>
                  {preview.conflicts.map((conflict) => (
                    <li
                      key={conflict.value}
                      className={css({ textStyle: 'small', fontFamily: 'mono', wordBreak: 'break-all' })}
                    >
                      {conflict.value}
                    </li>
                  ))}
                </ul>
              )}
              <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('dictionary.import.conflictsNote')}</p>
            </div>
            <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('dictionary.import.previewNote')}</p>
          </div>
        ) : null}

        {importMutation.isError ? (
          <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
            {dictionaryErrorMessage(importMutation.error)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
