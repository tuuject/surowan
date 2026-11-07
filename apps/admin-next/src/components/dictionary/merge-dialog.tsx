import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Checkbox } from '@tuuject/koi-react/checkbox';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Textarea } from '@tuuject/koi-react/textarea';
import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AliasEditor, ScopePicker } from '@/components/dictionary/entry-form.tsx';
import type {
  DictionaryChatOption,
  DictionaryEntry,
  DictionaryMergePreview,
  DictionaryScope,
} from '@/lib/api/dictionary.ts';
import { mergeDictionaryEntries, previewDictionaryMerge } from '@/lib/api/dictionary.ts';
import { dictionaryErrorMessage } from '@/lib/dictionary.ts';
import { toast } from '@/lib/toast.ts';

type MergeStep =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'ready'; readonly preview: DictionaryMergePreview };

/**
 * Two-step merge: the Tool Model proposes a suggestion (never writes), the
 * admin edits it, then explicitly picks the target scope and whether the
 * source entries are kept or deleted. The confirm carries each source's
 * revision, so a source edited after the suggestion was built makes the write
 * fail instead of silently basing the merge on stale data.
 */
export function MergeDialog({
  open,
  onOpenChange,
  entries,
  chats,
  defaultScope,
  defaultChatId,
  onMerged,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly entries: readonly DictionaryEntry[];
  readonly chats: readonly DictionaryChatOption[];
  readonly defaultScope: DictionaryScope;
  readonly defaultChatId: string | null;
  readonly onMerged: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<MergeStep>({ kind: 'idle' });
  const [term, setTerm] = useState('');
  const [definition, setDefinition] = useState('');
  const [aliases, setAliases] = useState<readonly string[]>([]);
  const [scope, setScope] = useState<DictionaryScope>(defaultScope);
  const [chatId, setChatId] = useState<string | null>(defaultChatId);
  const [deleteSources, setDeleteSources] = useState(false);

  const suggestion = useMutation({
    mutationFn: () => previewDictionaryMerge(entries.map((entry) => entry.id)),
    onMutate: () => setStep({ kind: 'loading' }),
    onSuccess: (preview) => {
      setTerm(preview.suggestion.term);
      setDefinition(preview.suggestion.definition);
      setAliases(preview.suggestion.aliases);
      setStep({ kind: 'ready', preview });
    },
    onError: (error) => setStep({ kind: 'failed', error }),
  });

  const save = useMutation({
    mutationFn: (preview: DictionaryMergePreview) =>
      mergeDictionaryEntries({
        entry: {
          term: term.trim(),
          definition: definition.trim(),
          aliases,
          scope,
          chat_id: scope === 'global' ? null : chatId,
          enabled: true,
        },
        sources: preview.sources.map((source) => ({ id: source.id, revision: source.revision })),
        delete_sources: deleteSources,
      }),
    onSuccess: () => {
      toast.success(
        deleteSources
          ? `${t('dictionary.merge.merged')} · ${t('dictionary.merge.sourcesDeleted')}`
          : t('dictionary.merge.merged'),
      );
      void queryClient.invalidateQueries({ queryKey: ['dictionary'] });
      onMerged();
      onOpenChange(false);
    },
    onError: () => {
      // The dialog stays open: a stale source is retryable after regenerating.
      void queryClient.invalidateQueries({ queryKey: ['dictionary'] });
    },
  });

  const preview = step.kind === 'ready' ? step.preview : null;
  const canSave = preview !== null && term.trim().length > 0 && definition.trim().length > 0;
  const scopeReady = scope === 'global' || (chatId !== null && chatId.length > 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && save.isPending) {
          return;
        }
        onOpenChange(next);
      }}
      title={t('dictionary.merge.title')}
      description={t('dictionary.merge.description')}
      size="lg"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            color="secondary"
            disabled={save.isPending}
            onClick={() => onOpenChange(false)}
          >
            {t('dictionary.merge.cancel')}
          </Button>
          <Button
            type="button"
            disabled={!canSave || !scopeReady || save.isPending || preview === null}
            onClick={() => {
              if (preview !== null) {
                save.mutate(preview);
              }
            }}
          >
            {save.isPending ? t('dictionary.merge.merging') : t('dictionary.merge.confirm')}
          </Button>
        </>
      }
    >
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          <p className={css({ textStyle: 'label' })}>{t('dictionary.merge.sources', { count: entries.length })}</p>
          <ul
            className={css({
              textStyle: 'body',
              maxHeight: '160px',
              '& > :not(:last-child)': { marginBlockEnd: '1' },
              overflow: 'auto',
            })}
          >
            {entries.map((entry) => (
              <li
                key={entry.id}
                className={css({
                  borderRadius: 'lg',
                  borderWidth: '1px',
                  borderColor: 'border',
                  paddingInline: '2',
                  paddingBlock: '1',
                })}
              >
                <span className={css({ textStyle: 'label' })}>{entry.term}</span>
                {entry.aliases.length === 0 ? null : (
                  <span className={css({ color: 'text-muted' })}> · {entry.aliases.join(', ')}</span>
                )}
                <span className={css({ textStyle: 'small', color: 'text-muted', display: 'block' })}>
                  {entry.scope === 'global'
                    ? t('dictionary.page.globalBadge')
                    : `${t('dictionary.page.groupBadge')} ${entry.chat_id ?? ''}`}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {step.kind === 'idle' || step.kind === 'loading' ? (
          <Button type="button" disabled={suggestion.isPending} onClick={() => suggestion.mutate()}>
            {suggestion.isPending ? t('dictionary.merge.generating') : t('dictionary.merge.generate')}
          </Button>
        ) : null}

        {step.kind === 'failed' ? (
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
            <Alert tone="error" title={t('dictionary.merge.generateFailed')}>
              {dictionaryErrorMessage(step.error)}
            </Alert>
            <Button type="button" variant="outline" color="secondary" onClick={() => suggestion.mutate()}>
              {t('dictionary.merge.regenerate')}
            </Button>
          </div>
        ) : null}

        {preview !== null ? (
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
            <Alert tone="info" title={t('dictionary.merge.suggestion')}>
              {t('dictionary.merge.suggestionHint')}
            </Alert>
            <Field id="merge-term" label={t('dictionary.merge.termLabel')}>
              <Input value={term} onChange={(event) => setTerm(event.target.value)} />
            </Field>
            <Field id="merge-definition" label={t('dictionary.merge.definitionLabel')}>
              <Textarea rows={4} value={definition} onChange={(event) => setDefinition(event.target.value)} />
            </Field>
            <Field label={t('dictionary.merge.aliasesLabel')}>
              <AliasEditor aliases={aliases} onChange={setAliases} />
            </Field>
            <ScopePicker
              label={t('dictionary.merge.targetScopeLabel')}
              scope={scope}
              chatId={chatId}
              chats={chats}
              onChange={(nextScope, nextChatId) => {
                setScope(nextScope);
                setChatId(nextChatId);
              }}
            />
            <Checkbox
              label={t('dictionary.merge.deleteSources')}
              description={t('dictionary.merge.deleteSourcesHint')}
              checked={deleteSources}
              onCheckedChange={setDeleteSources}
            />
            <Button type="button" variant="outline" color="secondary" onClick={() => suggestion.mutate()}>
              {t('dictionary.merge.regenerate')}
            </Button>
          </div>
        ) : null}

        {save.isError ? (
          <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
            {dictionaryErrorMessage(save.error)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
