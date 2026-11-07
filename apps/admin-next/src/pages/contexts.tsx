import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChatFilter,
  type ColumnSpec,
  CursorList,
  ListPageHeader,
  ListSearchForm,
  TableShell,
} from '@/components/business';
import type { ConversationContextListItem } from '@/lib/api/contexts.ts';
import { formatNumber, formatTime } from '@/lib/format';
import { chatQuery, useListQuery } from '@/lib/list-query';
import { conversationContextsQuery } from '@/lib/queries';
import { css } from '@tuuject/koi-react/styled-system/css';

const ID_LINK =
  'decoration-border hover:decoration-foreground font-medium tabular-nums underline underline-offset-4 transition-colors';
const EMPTY_FILTERS = { chat: '' };

export default function ContextsPage(): React.ReactElement {
  const { t } = useTranslation();
  const query = useListQuery(EMPTY_FILTERS);
  const filters = useMemo(() => ({ chat: chatQuery(query.value.chat) }), [query.value.chat]);

  const COLUMNS: readonly ColumnSpec<ConversationContextListItem>[] = [
    {
      key: 'conversation',
      title: t('invocations.contexts.columns.id'),
      render: (row) => (
        <Link to="/contexts/$conversationId" params={{ conversationId: row.conversation_id }} className={ID_LINK}>
          {row.conversation_id}
        </Link>
      ),
    },
    {
      key: 'chat',
      title: t('invocations.contexts.columns.chat'),
      className: 'min-w-48',
      render: (row) => (
        <div className={css({ minWidth: '0', '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          <div className={css({ textStyle: 'label', overflowWrap: 'anywhere' })}>
            {row.chat_title ?? row.telegram_chat_id}
          </div>
          <div className={css({ textStyle: 'small', color: 'text-muted' })}>
            {row.chat_type}
            {row.message_thread_id === 0 ? '' : ` · topic ${row.message_thread_id}`}
          </div>
        </div>
      ),
    },
    {
      key: 'window',
      title: t('invocations.contexts.columns.seqWindow'),
      className: 'tabular-nums',
      render: (row) => `${row.head_seq}–${row.next_seq}`,
    },
    {
      key: 'message_count',
      title: t('invocations.contexts.columns.messages'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => formatNumber(row.message_count),
    },
    {
      key: 'send_count_total',
      title: t('invocations.contexts.columns.sends'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => formatNumber(row.send_count_total),
    },
    {
      key: 'active_invocation',
      title: t('invocations.contexts.columns.activeSession'),
      className: 'ps-6',
      render: (row) =>
        row.active_invocation_id === null ? (
          <span className={css({ color: 'text-muted' })}>—</span>
        ) : (
          <Link to="/invocations/$invocationId" params={{ invocationId: row.active_invocation_id }} className={ID_LINK}>
            {row.active_invocation_id}
          </Link>
        ),
    },
    {
      key: 'last_active_at',
      title: t('invocations.contexts.columns.lastActive'),
      className: 'text-muted-foreground',
      render: (row) => formatTime(row.last_active_at),
    },
    {
      key: 'last_gc_at',
      title: t('invocations.contexts.columns.lastGc'),
      className: 'text-muted-foreground',
      render: (row) => formatTime(row.last_gc_at),
    },
  ];

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <ListPageHeader title={t('layout.nav.contexts')} />
      <ListSearchForm value={query.value} emptyValue={EMPTY_FILTERS} onSearch={query.apply}>
        {({ draft, change }) => <ChatFilter value={draft.chat} onChange={(chat) => change({ chat })} />}
      </ListSearchForm>
      <CursorList
        factory={conversationContextsQuery}
        filters={filters}
        renderItems={(items, { loading }) => (
          <TableShell
            columns={COLUMNS}
            data={items}
            rowKey={(row) => row.conversation_id}
            loading={loading}
            emptyText={t('invocations.contexts.empty.title')}
            emptyDescription={t('invocations.contexts.empty.description')}
          />
        )}
      />
    </div>
  );
}
