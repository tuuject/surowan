import { Badge } from '@tuuject/koi-react/badge';
import { IconButton } from '@tuuject/koi-react/button';
import { TrashIcon } from '@tuuject/koi-react/icons';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Switch } from '@tuuject/koi-react/switch';
import { Tag } from '@tuuject/koi-react/tag';
import type { TFunction } from 'i18next';
import { type ColumnSpec, RowActions, TimeText } from '@/components/business';
import { EditIcon } from '@/components/icons';
import type { DictionaryChatOption, DictionaryEntry } from '@/lib/api/dictionary.ts';

export interface DictionaryColumnsOptions {
  readonly t: TFunction;
  readonly chats: readonly DictionaryChatOption[];
  readonly conflicted: ReadonlySet<string>;
  readonly toggleEnabledPending: boolean;
  readonly onToggleEnabled: (entry: DictionaryEntry) => void;
  readonly onEdit: (entry: DictionaryEntry) => void;
  readonly onDelete: (entry: DictionaryEntry) => void;
}

/** Column specs for the entry table; selection lives in TableShell, every handler comes from the page. */
export function dictionaryColumns(options: DictionaryColumnsOptions): readonly ColumnSpec<DictionaryEntry>[] {
  const { t, chats, conflicted, toggleEnabledPending, onToggleEnabled, onEdit, onDelete } = options;

  return [
    {
      key: 'term',
      title: t('dictionary.page.colTerm'),
      width: 200,
      render: (entry) => (
        <span className={css({ display: 'flex', alignItems: 'center', gap: '2', minWidth: '0' })}>
          <span dir="auto" className={css({ truncate: true })}>
            {entry.term}
          </span>
          {conflicted.has(entry.id) ? <Badge tone="warning">{t('dictionary.conflicts.title')}</Badge> : null}
        </span>
      ),
    },
    {
      key: 'aliases',
      title: t('dictionary.page.colAliases'),
      render: (entry) =>
        entry.aliases.length === 0 ? (
          <span className={css({ color: 'text-muted' })}>{t('dictionary.page.noAliases')}</span>
        ) : (
          <span className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1' })}>
            {entry.aliases.map((alias) => (
              <Tag key={alias}>{alias}</Tag>
            ))}
          </span>
        ),
    },
    {
      key: 'definition',
      title: t('dictionary.page.colDefinition'),
      render: (entry) => (
        <div className={css({ lineClamp: '2', whiteSpace: 'normal', overflowWrap: 'anywhere' })}>
          {entry.definition}
        </div>
      ),
    },
    {
      key: 'scope',
      title: t('dictionary.page.colScope'),
      width: 160,
      render: (entry) => {
        if (entry.scope === 'global') {
          return t('dictionary.page.globalBadge');
        }
        const chat = chats.find((candidate) => candidate.id === entry.chat_id);
        return (
          <div className={css({ minWidth: '0' })}>
            <div>{t('dictionary.page.groupBadge')}</div>
            <div className={css({ textStyle: 'small', color: 'text-muted', truncate: true })}>
              {chat?.title ?? entry.chat_id ?? ''}
            </div>
          </div>
        );
      },
    },
    {
      key: 'enabled',
      title: t('dictionary.page.colEnabled'),
      width: 88,
      render: (entry) => (
        <Switch
          aria-label={t('dictionary.page.enabledAria', { term: entry.term })}
          checked={entry.enabled}
          disabled={toggleEnabledPending}
          onCheckedChange={() => onToggleEnabled(entry)}
        />
      ),
    },
    {
      key: 'updated_at',
      title: t('dictionary.page.colUpdated'),
      width: 184,
      skeleton: '2026-01-18 10:58:15',
      render: (entry) => <TimeText value={entry.updated_at} />,
    },
    {
      key: 'actions',
      title: t('dictionary.page.colActions'),
      align: 'right',
      width: 104,
      paddingBlock: 'none',
      render: (entry) => (
        <RowActions>
          <IconButton
            variant="ghost"
            color="secondary"
            label={t('dictionary.page.editAria', { term: entry.term })}
            icon={<EditIcon />}
            onClick={() => onEdit(entry)}
          />
          <IconButton
            variant="ghost"
            color="error"
            label={t('dictionary.page.deleteAria', { term: entry.term })}
            icon={<TrashIcon />}
            onClick={() => onDelete(entry)}
          />
        </RowActions>
      ),
    },
  ];
}
