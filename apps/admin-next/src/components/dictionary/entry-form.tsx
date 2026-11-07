import { Checkbox } from '@tuuject/koi-react/checkbox';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { RadioGroup } from '@tuuject/koi-react/radio-group';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Textarea } from '@tuuject/koi-react/textarea';
import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DictionaryChatOption, DictionaryDraft, DictionaryScope } from '@/lib/api/dictionary.ts';
import { aliasesEqual, formatAliasLines, parseAliasLines } from '@/lib/dictionary.ts';

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
  readonly idPrefix?: string;
}): React.ReactElement {
  const { t } = useTranslation();
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
      {...(idPrefix === undefined ? {} : { id: `${idPrefix}-aliases` })}
      rows={4}
      value={raw}
      disabled={disabled}
      className={css({ fontFamily: 'mono' })}
      placeholder={t('dictionary.entry.aliasPlaceholder')}
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
  readonly error?: string | undefined;
  /** The radio group's Field label; defaults to the entry's scope. */
  readonly label?: string;
  readonly onChange: (scope: DictionaryScope, chatId: string | null) => void;
}

/** Scope radio (global / group) plus the Chat select a group scope needs. */
export function ScopePicker({
  scope,
  chatId,
  chats,
  disabled = false,
  error,
  label,
  onChange,
}: ScopePickerProps): React.ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <Field label={label ?? t('dictionary.entry.scopeLabel')}>
        <RadioGroup
          orientation="horizontal"
          value={scope}
          disabled={disabled}
          onChange={(value) => {
            const next: DictionaryScope = value === 'group' ? 'group' : 'global';
            onChange(next, next === 'global' ? null : (chatId ?? chats[0]?.id ?? null));
          }}
          options={[
            { value: 'global', label: t('dictionary.entry.scopeGlobal') },
            { value: 'group', label: t('dictionary.entry.scopeGroup') },
          ]}
        />
      </Field>
      {scope === 'group' ? (
        <Field label={t('dictionary.entry.chatLabel')} help={t('dictionary.entry.scopeGroupHint')} error={error}>
          <Select
            placeholder={t('dictionary.scope.selectChat')}
            value={chatId ?? ''}
            disabled={disabled}
            onChange={(event) => onChange('group', event.target.value)}
            options={chats.map((chat) => ({
              value: chat.id,
              label: chat.title === null ? chat.id : `${chat.title}（${chat.id}）`,
            }))}
          />
        </Field>
      ) : null}
    </>
  );
}

/** Shared field block for the create dialog and the edit dialog. */
export function EntryFormFields({
  draft,
  onChange,
  chats,
  errors,
  disabled,
}: {
  readonly draft: DictionaryDraft;
  readonly onChange: (draft: DictionaryDraft) => void;
  readonly chats: readonly DictionaryChatOption[];
  readonly errors: { readonly term?: string; readonly definition?: string; readonly chat_id?: string };
  readonly disabled: boolean;
  readonly idPrefix?: string;
}): React.ReactElement {
  const { t } = useTranslation();

  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
      <Field label={t('dictionary.entry.termLabel')} error={errors.term}>
        <Input
          value={draft.term}
          disabled={disabled}
          placeholder={t('dictionary.entry.termPlaceholder')}
          onChange={(event) => onChange({ ...draft, term: event.target.value })}
        />
      </Field>
      <Field label={t('dictionary.entry.definitionLabel')} error={errors.definition}>
        <Textarea
          rows={4}
          value={draft.definition}
          disabled={disabled}
          placeholder={t('dictionary.entry.definitionPlaceholder')}
          onChange={(event) => onChange({ ...draft, definition: event.target.value })}
        />
      </Field>
      <Field label={t('dictionary.entry.aliasesLabel')} help={t('dictionary.entry.aliasesHint')}>
        <AliasEditor
          aliases={draft.aliases}
          disabled={disabled}
          onChange={(aliases) => onChange({ ...draft, aliases })}
        />
      </Field>
      <ScopePicker
        scope={draft.scope}
        chatId={draft.chat_id}
        chats={chats}
        disabled={disabled}
        error={errors.chat_id}
        onChange={(scope, chatId) => onChange({ ...draft, scope, chat_id: chatId })}
      />
      <Checkbox
        label={t('dictionary.entry.enabledLabel')}
        description={t('dictionary.entry.enabledHint')}
        checked={draft.enabled}
        disabled={disabled}
        onCheckedChange={(enabled) => onChange({ ...draft, enabled })}
      />
    </div>
  );
}
