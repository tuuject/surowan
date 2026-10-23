import type { TFunction } from 'i18next';
import { AlertTriangle } from 'lucide-react';
import { type ColumnSpec, ToneBadge } from '@/components/business';
import { Button } from '@/components/ui/button';

import { formatTime } from '@/lib/format';
import type { DictionaryChatOption, DictionaryEntry, DictionaryScope } from '@/lib/api/dictionary.ts';

function targetLabel(
  entry: { readonly scope: DictionaryScope; readonly chat_id: string | null },
  chats: readonly DictionaryChatOption[],
  t: TFunction,
): string {
  if (entry.scope === 'global') {
    return t('dictionary.page.globalBadge');
  }
  const chat = chats.find((candidate) => candidate.id === entry.chat_id);
  return `${t('dictionary.page.groupBadge')} · ${chat?.title ?? entry.chat_id ?? ''}`;
}

export interface DictionaryColumnsOptions {
  readonly t: TFunction;
  readonly chats: readonly DictionaryChatOption[];
  readonly conflicted: ReadonlySet<string>;
  readonly selected: ReadonlySet<string>;
  readonly toggleEnabledPending: boolean;
  readonly onToggleSelected: (id: string) => void;
  readonly onToggleEnabled: (entry: DictionaryEntry) => void;
  readonly onEdit: (entry: DictionaryEntry) => void;
  readonly onDelete: (entry: DictionaryEntry) => void;
}

/** Column specs for the entry table; all handlers come from the page. */
export function dictionaryColumns(options: DictionaryColumnsOptions): readonly ColumnSpec<DictionaryEntry>[] {
  const { t, chats, conflicted, selected, toggleEnabledPending, onToggleSelected, onToggleEnabled, onEdit, onDelete } =
    options;

  return [
    {
      key: 'select',
      title: '',
      render: (entry) => (
        <input
          type="checkbox"
          className="size-4 rounded border-input"
          aria-label={t('dictionary.page.selectAria', { term: entry.term })}
          checked={selected.has(entry.id)}
          onChange={() => onToggleSelected(entry.id)}
        />
      ),
    },
    {
      key: 'term',
      title: t('dictionary.page.colTerm'),
      className: 'whitespace-normal',
      render: (entry) => (
        <span className="flex flex-wrap items-center gap-1">
          <span className="font-medium">{entry.term}</span>
          {conflicted.has(entry.id) ? (
            <ToneBadge tone="warning">
              <AlertTriangle className="size-3" />
              {t('dictionary.conflicts.title')}
            </ToneBadge>
          ) : null}
        </span>
      ),
    },
    {
      key: 'aliases',
      title: t('dictionary.page.colAliases'),
      className: 'max-w-64 min-w-32 whitespace-normal',
      render: (entry) =>
        entry.aliases.length === 0 ? (
          <span className="text-muted-foreground">{t('dictionary.page.noAliases')}</span>
        ) : (
          <span className="flex flex-wrap items-center gap-1">
            {entry.aliases.map((alias) => (
              <span key={alias} className="bg-muted rounded px-1.5 py-0.5 text-xs">
                {alias}
              </span>
            ))}
          </span>
        ),
    },
    {
      key: 'definition',
      title: t('dictionary.page.colDefinition'),
      className: 'max-w-80 min-w-48 whitespace-normal',
      render: (entry) => <div className="line-clamp-2">{entry.definition}</div>,
    },
    {
      key: 'scope',
      title: t('dictionary.page.colScope'),
      render: (entry) => <span className="text-sm">{targetLabel(entry, chats, t)}</span>,
    },
    {
      key: 'enabled',
      title: t('dictionary.page.colEnabled'),
      render: (entry) => (
        <button
          type="button"
          className="text-sm underline-offset-4 hover:underline"
          disabled={toggleEnabledPending}
          onClick={() => onToggleEnabled(entry)}
        >
          {entry.enabled ? t('dictionary.page.enabledOn') : t('dictionary.page.enabledOff')}
        </button>
      ),
    },
    { key: 'updated_at', title: t('dictionary.page.colUpdated'), render: (entry) => formatTime(entry.updated_at) },
    {
      key: 'actions',
      title: t('dictionary.page.colActions'),
      render: (entry) => (
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={t('dictionary.page.editAria', { term: entry.term })}
            onClick={() => onEdit(entry)}
          >
            {t('common.edit')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            aria-label={t('dictionary.page.deleteAria', { term: entry.term })}
            onClick={() => onDelete(entry)}
          >
            {t('common.delete')}
          </Button>
        </div>
      ),
    },
  ];
}
