import { X } from 'lucide-react';
import type React from 'react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { DictionaryChatOption, DictionaryDraft, DictionaryScope } from '@/lib/api.ts';
import { normalizeAliases, parseAliasList } from '@/lib/dictionary.ts';
import { cn } from '@/lib/utils';

/**
 * The alias editor: a row per alias plus a paste box. Adding a pasted list
 * splits on newline, comma or `|` (the same separators the CSV export uses for
 * its alias cell) and deduplicates.
 */
export function AliasEditor({
  aliases,
  onChange,
  disabled = false,
  idPrefix,
}: {
  readonly aliases: readonly string[];
  readonly onChange: (aliases: readonly string[]) => void;
  readonly disabled?: boolean;
  readonly idPrefix: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [bulk, setBulk] = useState('');
  const bulkId = `${idPrefix}-bulk`;

  const add = (values: readonly string[]): void => {
    onChange(normalizeAliases([...aliases, ...values]));
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        {aliases.length === 0 ? <span className="text-muted-foreground text-sm">—</span> : null}
        {aliases.map((alias) => (
          <span
            key={alias}
            className="bg-muted inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-sm"
            data-testid={`alias-${alias}`}
          >
            {alias}
            <button
              type="button"
              className="text-muted-foreground hover:text-destructive"
              aria-label={t('dictionary.entry.aliasRemoveAria', { alias })}
              disabled={disabled}
              onClick={() => onChange(aliases.filter((value) => value !== alias))}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <Input
          value={draft}
          disabled={disabled}
          placeholder={t('dictionary.entry.aliasPlaceholder')}
          aria-label={t('dictionary.entry.aliasPlaceholder')}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add([draft]);
              setDraft('');
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || draft.trim().length === 0}
          onClick={() => {
            add([draft]);
            setDraft('');
          }}
        >
          {t('dictionary.entry.aliasAdd')}
        </Button>
      </div>
      <div className="space-y-1">
        <Label htmlFor={bulkId}>{t('dictionary.entry.aliasBulkLabel')}</Label>
        <Textarea
          id={bulkId}
          rows={2}
          value={bulk}
          disabled={disabled}
          onChange={(event) => setBulk(event.target.value)}
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs">{t('dictionary.entry.aliasBulkHint')}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || parseAliasList(bulk).length === 0}
            onClick={() => {
              add(parseAliasList(bulk));
              setBulk('');
            }}
          >
            {t('dictionary.entry.aliasBulkAdd')}
          </Button>
        </div>
      </div>
    </div>
  );
}

export interface ScopePickerProps {
  readonly scope: DictionaryScope;
  readonly chatId: string | null;
  readonly chats: readonly DictionaryChatOption[];
  readonly disabled?: boolean;
  readonly idPrefix: string;
  readonly onChange: (scope: DictionaryScope, chatId: string | null) => void;
}

/** Scope radio (global / group) plus the Chat select a group scope needs. */
export function ScopePicker({
  scope,
  chatId,
  chats,
  disabled = false,
  idPrefix,
  onChange,
}: ScopePickerProps): React.ReactElement {
  const { t } = useTranslation();
  const selectId = `${idPrefix}-chat`;
  const options: readonly { readonly value: DictionaryScope; readonly label: string }[] = [
    { value: 'global', label: t('dictionary.entry.scopeGlobal') },
    { value: 'group', label: t('dictionary.entry.scopeGroup') },
  ];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        {options.map((option) => (
          <Button
            key={option.value}
            type="button"
            size="sm"
            variant={scope === option.value ? 'default' : 'outline'}
            disabled={disabled}
            aria-pressed={scope === option.value}
            onClick={() => onChange(option.value, option.value === 'global' ? null : (chatId ?? chats[0]?.id ?? null))}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {scope === 'group' ? (
        <div className="space-y-1">
          <Label htmlFor={selectId}>{t('dictionary.entry.chatLabel')}</Label>
          <Select
            {...(chatId === null ? {} : { value: chatId })}
            disabled={disabled}
            onValueChange={(value) => onChange('group', value)}
          >
            <SelectTrigger id={selectId} className="w-full" aria-label={t('dictionary.entry.chatLabel')}>
              <SelectValue placeholder={t('dictionary.scope.selectChat')} />
            </SelectTrigger>
            <SelectContent>
              {chats.map((chat) => (
                <SelectItem key={chat.id} value={chat.id}>
                  {chat.title === null ? chat.id : `${chat.title} · ${chat.id}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">{t('dictionary.entry.scopeGroupHint')}</p>
        </div>
      ) : null}
    </div>
  );
}

/** Shared field block for the create dialog and the edit dialog. */
export function EntryFormFields({
  draft,
  onChange,
  chats,
  errors,
  disabled,
  idPrefix,
}: {
  readonly draft: DictionaryDraft;
  readonly onChange: (draft: DictionaryDraft) => void;
  readonly chats: readonly DictionaryChatOption[];
  readonly errors: { readonly term?: string; readonly definition?: string; readonly chat_id?: string };
  readonly disabled: boolean;
  readonly idPrefix: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const termId = useId();
  const definitionId = useId();

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={termId}>{t('dictionary.entry.termLabel')}</Label>
        <Input
          id={termId}
          value={draft.term}
          disabled={disabled}
          placeholder={t('dictionary.entry.termPlaceholder')}
          onChange={(event) => onChange({ ...draft, term: event.target.value })}
        />
        {errors.term !== undefined ? <p className="text-destructive text-sm">{errors.term}</p> : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor={definitionId}>{t('dictionary.entry.definitionLabel')}</Label>
        <Textarea
          id={definitionId}
          rows={4}
          value={draft.definition}
          disabled={disabled}
          placeholder={t('dictionary.entry.definitionPlaceholder')}
          onChange={(event) => onChange({ ...draft, definition: event.target.value })}
        />
        {errors.definition !== undefined ? <p className="text-destructive text-sm">{errors.definition}</p> : null}
      </div>
      <div className="space-y-2">
        <Label>{t('dictionary.entry.aliasesLabel')}</Label>
        <AliasEditor
          aliases={draft.aliases}
          disabled={disabled}
          idPrefix={idPrefix}
          onChange={(aliases) => onChange({ ...draft, aliases })}
        />
        <p className="text-muted-foreground text-xs">{t('dictionary.entry.aliasesHint')}</p>
      </div>
      <div className="space-y-2">
        <Label>{t('dictionary.entry.scopeLabel')}</Label>
        <ScopePicker
          scope={draft.scope}
          chatId={draft.chat_id}
          chats={chats}
          disabled={disabled}
          idPrefix={idPrefix}
          onChange={(scope, chatId) => onChange({ ...draft, scope, chat_id: chatId })}
        />
        {errors.chat_id !== undefined ? <p className="text-destructive text-sm">{errors.chat_id}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        <input
          id={`${idPrefix}-enabled`}
          type="checkbox"
          className="size-4 rounded border-input"
          checked={draft.enabled}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
        />
        <Label htmlFor={`${idPrefix}-enabled`} className="font-normal">
          {t('dictionary.entry.enabledLabel')}
        </Label>
      </div>
      <p className={cn('text-muted-foreground text-xs')}>{t('dictionary.entry.enabledHint')}</p>
    </div>
  );
}
