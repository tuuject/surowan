import type { TFunction } from 'i18next';
import { type ColumnSpec, MonoValue } from '@/components/business';
import { Button } from '@/components/ui/button';
import type { MemoryEntry } from '@/lib/api/memories.ts';
import { formatTime } from '@/lib/format';
import { formatTtl } from '@/lib/memory-ttl';
import { MemoryStatus } from './memories-status.tsx';

export interface MemoryColumnActions {
  readonly onView: (row: MemoryEntry) => void;
  readonly onEdit: (row: MemoryEntry) => void;
  readonly onDelete: (row: MemoryEntry) => void;
}

export function memoryColumns(t: TFunction, actions: MemoryColumnActions): readonly ColumnSpec<MemoryEntry>[] {
  return [
    { key: 'id', title: t('pages.memories.colId'), render: (row) => <MonoValue value={row.id} /> },
    {
      key: 'chat',
      title: t('pages.memories.colChat'),
      render: (row) => (
        <div className="min-w-0 space-y-0.5">
          <div className="font-medium">{row.chat.title ?? row.chat.telegram_chat_id}</div>
          <div className="text-muted-foreground text-xs">{row.chat.telegram_chat_id}</div>
        </div>
      ),
    },
    {
      key: 'summary',
      title: t('pages.memories.colSummary'),
      className: 'max-w-80 min-w-40 whitespace-normal',
      render: (row) => <div className="line-clamp-2 whitespace-normal">{row.summary}</div>,
    },
    { key: 'created_at', title: t('pages.memories.colCreated'), render: (row) => formatTime(row.created_at) },
    {
      key: 'expires_at',
      title: t('pages.memories.colExpires'),
      render: (row) => (row.expires_at === null ? t('pages.memories.permanent') : formatTime(row.expires_at)),
    },
    {
      key: 'ttl',
      title: t('pages.memories.colTtl'),
      render: (row) => (row.ttl_seconds === null ? t('pages.memories.permanent') : formatTtl(row.ttl_seconds)),
    },
    { key: 'status', title: t('pages.memories.colStatus'), render: (row) => <MemoryStatus row={row} /> },
    {
      key: 'actions',
      title: t('pages.memories.colActions'),
      render: (row) => (
        <div className="flex items-center gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={() => actions.onView(row)}>
            {t('pages.memories.view')}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => actions.onEdit(row)}>
            {t('common.edit')}
          </Button>
          <Button type="button" size="sm" variant="destructive" onClick={() => actions.onDelete(row)}>
            {t('common.delete')}
          </Button>
        </div>
      ),
    },
  ];
}
