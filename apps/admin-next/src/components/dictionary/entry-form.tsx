import type React from 'react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

import { aliasesEqual, formatAliasLines, parseAliasLines } from '@/lib/dictionary.ts';
import { cn } from '@/lib/utils';
import type { DictionaryChatOption, DictionaryDraft, DictionaryScope } from '@/lib/api/dictionary.ts';

/**
 * The alias editor: exactly one textarea, one alias per line. Every keystroke
 * is a synchronous save — the textarea owns its raw text and reports the
 * parsed list on each change, so there is no Add button to forget and no
 * second paste path. Only a newline separates aliases: a comma and a `|` stay
 * literal parts of their alias.
 *
 * Keeping the raw text in local state (rather than `aliases.join('\n')`) is
 * what makes Enter, a trailing newline and IME composition safe: re-parsing
 * the prop and joining it back would delete the empty line the admin is still
 * typing on and move the caret. The raw text is adopted from the prop only
 * when the prop stops being the echo of the current parse — e.g. a merge
 * suggestion arriving or a different entry being opened.
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
  const textareaId = `${idPrefix}-aliases`;
  const [raw, setRaw] = useState<string>(() => formatAliasLines(aliases));
  // The list `raw` last produced; when the incoming prop differs from it, the
  // aliases changed elsewhere and the textarea adopts the new value.
  const [echoed, setEchoed] = useState<readonly string[]>(aliases);

  if (!aliasesEqual(aliases, echoed)) {
    setEchoed(aliases);
    setRaw(formatAliasLines(aliases));
  }

  return (
    <Textarea
      id={textareaId}
      rows={4}
      value={raw}
      disabled={disabled}
      className="font-mono"
      placeholder={t('dictionary.entry.aliasPlaceholder')}
      aria-label={t('dictionary.entry.aliasesLabel')}
      onChange={(event) => {
        const next = event.target.value;
        const parsed = parseAliasLines(next);
        setRaw(next);
        setEchoed(parsed);
        onChange(parsed);
      }}
    />
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
