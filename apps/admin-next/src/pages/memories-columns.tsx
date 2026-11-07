import { IconButton } from '@tuuject/koi-react/button';
import { TrashIcon } from '@tuuject/koi-react/icons';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { TFunction } from 'i18next';
import { type ColumnSpec, MonoValue, RowActions } from '@/components/business';
import { EditIcon, EyeIcon } from '@/components/icons';
import type { MemoryEntry } from '@/lib/api/memories.ts';
import { formatTime } from '@/lib/format';
import { MemoryStatus } from './memories-status.tsx';

export interface MemoryColumnActions {
  readonly onView: (row: MemoryEntry) => void;
  readonly onEdit: (row: MemoryEntry) => void;
  readonly onDelete: (row: MemoryEntry) => void;
}

const secondaryLine = css({ textStyle: 'small', color: 'text-muted', truncate: true });

/**
 * Summary and chat are the two free-text columns that share the spare width;
 * the memo ID rides under its summary instead of taking a 300px column of its own.
 */
export function memoryColumns(t: TFunction, actions: MemoryColumnActions): readonly ColumnSpec<MemoryEntry>[] {
  return [
    {
      key: 'summary',
      title: t('pages.memories.colSummary'),
      render: (row) => (
        <div className={css({ minWidth: '0' })}>
          <div className={css({ truncate: true })} title={row.summary}>
            {row.summary}
          </div>
          <div className={secondaryLine}>
            <MonoValue value={row.id} />
          </div>
        </div>
      ),
    },
    {
      key: 'chat',
      title: t('pages.memories.colChat'),
      render: (row) => (
        <div className={css({ minWidth: '0' })}>
          <div className={css({ truncate: true })}>{row.chat.title ?? row.chat.telegram_chat_id}</div>
          <div className={secondaryLine}>{row.chat.telegram_chat_id}</div>
        </div>
      ),
    },
    {
      key: 'status',
      title: t('pages.memories.colStatus'),
      width: 104,
      render: (row) => <MemoryStatus row={row} />,
    },
    {
      key: 'expires_at',
      title: t('pages.memories.colExpires'),
      width: 184,
      skeleton: '2026-01-18 10:58:15',
      render: (row) => (row.expires_at === null ? t('pages.memories.permanent') : formatTime(row.expires_at)),
    },
    {
      key: 'created_at',
      title: t('pages.memories.colCreated'),
      width: 184,
      skeleton: '2026-01-18 10:58:15',
      render: (row) => formatTime(row.created_at),
    },
    {
      key: 'actions',
      title: t('pages.memories.colActions'),
      align: 'right',
      width: 140,
      paddingBlock: 'none',
      render: (row) => (
        <RowActions>
          <IconButton
            variant="ghost"
            color="secondary"
            label={t('pages.memories.view')}
            icon={<EyeIcon />}
            onClick={() => actions.onView(row)}
          />
          <IconButton
            variant="ghost"
            color="secondary"
            label={t('common.edit')}
            icon={<EditIcon />}
            onClick={() => actions.onEdit(row)}
          />
          <IconButton
            variant="ghost"
            color="error"
            label={t('common.delete')}
            icon={<TrashIcon />}
            onClick={() => actions.onDelete(row)}
          />
        </RowActions>
      ),
    },
  ];
}
