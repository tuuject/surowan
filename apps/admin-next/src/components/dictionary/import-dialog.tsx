import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { DropZone } from '@tuuject/koi-react/drop-zone';
import { Field } from '@tuuject/koi-react/field';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Textarea } from '@tuuject/koi-react/textarea';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScopePicker } from '@/components/dictionary/entry-form.tsx';
import { useOpenSession } from '@/hooks/use-open-session.ts';
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
}): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [format, setFormat] = useState<DictionaryExportFormat>('csv');
  const [scope, setScope] = useState<DictionaryScope>(defaultScope);
  const [chatId, setChatId] = useState<string | null>(defaultChatId);
  const [content, setContent] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<DictionaryImportPreview | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [importError, setImportError] = useState<unknown>(null);
  // Closing is not blocked while a dropped file is still being read, so a read
  // carries the session it started in and is dropped once that session is over.
  const session = useOpenSession(open);

  const reset = (): void => {
    setFormat('csv');
    setScope(defaultScope);
    setChatId(defaultChatId);
    setContent('');
    setFileName(null);
    setPreview(null);
    setReadError(null);
    setPreviewError(null);
    setImportError(null);
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
    onError: setPreviewError,
  });

  const importMutation = useMutation({
    mutationFn: (entries: readonly DictionaryDraft[]) => importDictionaryEntries(entries),
    onSuccess: (result) => {
      toast.success(t('dictionary.import.imported', { count: result.items.length }));
      void queryClient.invalidateQueries({ queryKey: ['dictionary'] });
      onImported();
      onOpenChange(false);
    },
    onError: (error) => {
      // The dialog stays open so the parsed preview and the error are both visible.
      setImportError(error);
      void queryClient.invalidateQueries({ queryKey: ['dictionary'] });
    },
  });

  // Base UI keeps the popup mounted while it fades out, so this component
  // outlives a session: the previous file, parsed preview and scope must not
  // show up again. They are replaced on the open edge — a render-phase
  // adjustment, the app's substitute for a reset effect — and never on close,
  // so the review the admin just read stays on screen through the exit fade.
  // Failures are local state for that reason: a mutation cannot be reset while
  // rendering.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      reset();
    }
  }

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
            onClick={() => onOpenChange(false)}
          >
            {t('dictionary.import.cancel')}
          </Button>
          <Button
            type="button"
            variant="outline"
            color="secondary"
            disabled={content.trim().length === 0 || previewMutation.isPending || importMutation.isPending}
            onClick={() => {
              setPreviewError(null);
              previewMutation.mutate();
            }}
          >
            {previewMutation.isPending ? t('dictionary.import.previewing') : t('dictionary.import.preview')}
          </Button>
          <Button
            type="button"
            disabled={
              preview === null || draftEntries.length === 0 || importMutation.isPending || previewMutation.isPending
            }
            onClick={() => {
              setImportError(null);
              importMutation.mutate(draftEntries);
            }}
          >
            {importMutation.isPending
              ? t('dictionary.import.importing')
              : t('dictionary.import.confirm', { count: draftEntries.length })}
          </Button>
        </>
      }
    >
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
        <Field label={t('dictionary.import.formatLabel')}>
          <Select
            value={format}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'csv' || value === 'jsonl') {
                setFormat(value);
                setPreview(null);
              }
            }}
            options={[
              { value: 'csv', label: t('dictionary.import.csv') },
              { value: 'jsonl', label: t('dictionary.import.jsonl') },
            ]}
          />
        </Field>
        <Field
          label={t('dictionary.import.fileLabel')}
          error={readError ?? undefined}
          {...(fileName === null
            ? {}
            : { help: t('dictionary.import.fileLoaded', { name: fileName, chars: String(content.length) }) })}
        >
          <DropZone
            multiple={false}
            accept={format === 'csv' ? '.csv,text/csv' : '.jsonl,.json,application/jsonl'}
            description={format === 'csv' ? t('dictionary.import.csv') : t('dictionary.import.jsonl')}
            onFiles={(files) => {
              const file = files[0];
              if (file === undefined) {
                return;
              }
              const startedIn = session.current;
              setReadError(null);
              setPreview(null);
              void file
                .text()
                .then((text) => {
                  if (startedIn === session.current) {
                    setContent(text);
                    setFileName(file.name);
                  }
                })
                .catch(() => {
                  if (startedIn === session.current) {
                    setReadError(t('dictionary.import.fileFailed'));
                  }
                });
            }}
          />
        </Field>

        <ScopePicker
          label={t('dictionary.import.scopeLabel')}
          scope={scope}
          chatId={chatId}
          chats={chats}
          onChange={(nextScope, nextChatId) => {
            setScope(nextScope);
            setChatId(nextChatId);
            setPreview(null);
          }}
        />

        <Field label={t('dictionary.import.pasteLabel')}>
          <Textarea
            rows={5}
            className={css({ fontFamily: 'mono' })}
            value={content}
            onChange={(event) => {
              setContent(event.target.value);
              setFileName(null);
              setPreview(null);
            }}
            dir="ltr"
          />
        </Field>

        {content.trim().length === 0 ? (
          <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('dictionary.import.contentRequired')}</p>
        ) : null}
        {previewError !== null ? (
          <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
            {t('dictionary.import.previewFailed')}：{dictionaryErrorMessage(previewError)}
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
            </div>
            <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('dictionary.import.previewNote')}</p>
          </div>
        ) : null}

        {importError !== null ? (
          <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
            {dictionaryErrorMessage(importError)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
