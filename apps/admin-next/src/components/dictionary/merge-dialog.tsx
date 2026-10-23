import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AliasEditor, ScopePicker } from '@/components/dictionary/entry-form.tsx';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Textarea } from '@/components/ui/textarea';

import { dictionaryErrorMessage } from '@/lib/dictionary.ts';
import { mergeDictionaryEntries, previewDictionaryMerge } from '@/lib/api/dictionary.ts';
import type {
  DictionaryChatOption,
  DictionaryEntry,
  DictionaryMergePreview,
  DictionaryScope,
} from '@/lib/api/dictionary.ts';

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
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('dictionary.merge.title')}</DialogTitle>
          <DialogDescription>{t('dictionary.merge.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <p className="font-medium">{t('dictionary.merge.sources', { count: entries.length })}</p>
            <ul className="max-h-40 space-y-1 overflow-auto text-sm">
              {entries.map((entry) => (
                <li key={entry.id} className="rounded-md border px-2 py-1">
                  <span className="font-medium">{entry.term}</span>
                  {entry.aliases.length === 0 ? null : (
                    <span className="text-muted-foreground"> · {entry.aliases.join(', ')}</span>
                  )}
                  <span className="text-muted-foreground block text-xs">
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
            <div className="space-y-2">
              <Alert variant="destructive">
                <AlertTitle>{t('dictionary.merge.generateFailed')}</AlertTitle>
                <AlertDescription>{dictionaryErrorMessage(step.error)}</AlertDescription>
              </Alert>
              <Button type="button" variant="outline" onClick={() => suggestion.mutate()}>
                {t('dictionary.merge.regenerate')}
              </Button>
            </div>
          ) : null}

          {preview !== null ? (
            <div className="space-y-4">
              <Alert>
                <Info className="text-foreground" />
                <AlertTitle>{t('dictionary.merge.suggestion')}</AlertTitle>
                <AlertDescription>{t('dictionary.merge.suggestionHint')}</AlertDescription>
              </Alert>
              <div className="space-y-2">
                <Label htmlFor="merge-term">{t('dictionary.merge.termLabel')}</Label>
                <Input id="merge-term" value={term} onChange={(event) => setTerm(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="merge-definition">{t('dictionary.merge.definitionLabel')}</Label>
                <Textarea
                  id="merge-definition"
                  rows={4}
                  value={definition}
                  onChange={(event) => setDefinition(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('dictionary.merge.aliasesLabel')}</Label>
                <AliasEditor aliases={aliases} onChange={setAliases} idPrefix="merge" />
              </div>
              <div className="space-y-2">
                <Label>{t('dictionary.merge.targetScopeLabel')}</Label>
                <ScopePicker
                  scope={scope}
                  chatId={chatId}
                  chats={chats}
                  idPrefix="merge-scope"
                  onChange={(nextScope, nextChatId) => {
                    setScope(nextScope);
                    setChatId(nextChatId);
                  }}
                />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <input
                    id="merge-delete-sources"
                    type="checkbox"
                    className="size-4 rounded border-input"
                    checked={deleteSources}
                    onChange={(event) => setDeleteSources(event.target.checked)}
                  />
                  <Label htmlFor="merge-delete-sources" className="font-normal">
                    {t('dictionary.merge.deleteSources')}
                  </Label>
                </div>
                <p className="text-muted-foreground text-xs">{t('dictionary.merge.deleteSourcesHint')}</p>
              </div>
              <Button type="button" variant="outline" onClick={() => suggestion.mutate()}>
                {t('dictionary.merge.regenerate')}
              </Button>
            </div>
          ) : null}

          {save.isError ? (
            <p className="text-destructive text-sm break-words">{dictionaryErrorMessage(save.error)}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={save.isPending} onClick={() => onOpenChange(false)}>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
