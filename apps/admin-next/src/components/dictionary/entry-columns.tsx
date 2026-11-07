import type { TFunction } from 'i18next';
import { WarningIcon } from '@tuuject/koi-react/icons';
import { type ColumnSpec, ToneBadge } from '@/components/business';
import { Button } from '@tuuject/koi-react/button';
import type { DictionaryChatOption, DictionaryEntry, DictionaryScope } from '@/lib/api/dictionary.ts';
import { formatTime } from '@/lib/format';
import { css } from '@tuuject/koi-react/styled-system/css';

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
          className={css({ width: 'icon', height: 'icon', borderRadius: 'lg', borderColor: 'border-control' })}
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
        <span className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1' })}>
          <span className={css({ textStyle: 'label' })}>{entry.term}</span>
          {conflicted.has(entry.id) ? (
            <ToneBadge tone="warning">
              <WarningIcon className={css({ width: 'icon-xs', height: 'icon-xs' })} />
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
          <span className={css({ color: 'text-muted' })}>{t('dictionary.page.noAliases')}</span>
        ) : (
          <span className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1' })}>
            {entry.aliases.map((alias) => (
              <span
                key={alias}
                className={css({
                  textStyle: 'small',
                  bg: 'surface-muted',
                  borderRadius: 'lg',
                  paddingInline: '2',
                  paddingBlock: '1',
                })}
              >
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
      render: (entry) => <div className={css({ lineClamp: '2' })}>{entry.definition}</div>,
    },
    {
      key: 'scope',
      title: t('dictionary.page.colScope'),
      render: (entry) => <span className={css({ textStyle: 'body' })}>{targetLabel(entry, chats, t)}</span>,
    },
    {
      key: 'enabled',
      title: t('dictionary.page.colEnabled'),
      render: (entry) => (
        <button
          type="button"
          className={css({
            textStyle: 'body',
            textUnderlineOffset: '4px',
            _hover: { textDecorationLine: 'underline' },
          })}
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
        <div className={css({ display: 'flex', alignItems: 'center', gap: '1' })}>
          <Button
            type="button"
            size="sm"
            variant="outline"
            color="secondary"
            aria-label={t('dictionary.page.editAria', { term: entry.term })}
            onClick={() => onEdit(entry)}
          >
            {t('common.edit')}
          </Button>
          <Button
            type="button"
            size="sm"
            color="error"
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
