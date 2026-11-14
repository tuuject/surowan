import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChatFilter,
  type ColumnSpec,
  ListPageHeader,
  ListSearchForm,
  SnapshotList,
  TableShell,
  TechText,
  TimeText,
} from '@/components/business';
import { AppLink } from '@/components/router-links';
import type { ConversationContextListItem } from '@/lib/api/contexts.ts';
import { formatNumber } from '@/lib/format';
import { chatQuery, useListQuery } from '@/lib/list-query';
import { conversationContextsQuery } from '@/lib/queries';

const EMPTY_FILTERS = { chat: '' };

export default function ContextsPage(): ReactElement {
  const { t } = useTranslation();
  const query = useListQuery(EMPTY_FILTERS);
  const filters = useMemo(() => ({ chat: chatQuery(query.value.chat) }), [query.value.chat]);

  const COLUMNS: readonly ColumnSpec<ConversationContextListItem>[] = [
    {
      key: 'conversation',
      title: t('invocations.contexts.columns.id'),
      width: 104,
      skeleton: '1024',
      render: (row) => (
        <AppLink to="/contexts/$conversationId" params={{ conversationId: row.conversation_id }}>
          {row.conversation_id}
        </AppLink>
      ),
    },
    {
      key: 'chat',
      title: t('invocations.contexts.columns.chat'),
      render: (row) => (
        <div className={css({ minWidth: '0' })}>
          {/* Free-text title: its own direction, and it truncates at the end of the string, not the line. */}
          <div dir="auto" className={css({ truncate: true })}>
            {row.chat_title ?? <TechText>{row.telegram_chat_id}</TechText>}
          </div>
          <div
            // One clipped meta line, like develop: wrapping here made every row taller at phone width.
            className={css({
              display: 'flex',
              gap: '2',
              minWidth: '0',
              overflow: 'hidden',
              textStyle: 'small',
              color: 'text-muted',
            })}
          >
            <span>{row.chat_type}</span>
            {row.message_thread_id === 0 ? null : (
              <span>{t('invocations.invocations.topicLabel', { id: row.message_thread_id })}</span>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'window',
      title: t('invocations.contexts.columns.seqWindow'),
      width: 128,
      render: (row) => `${row.head_seq}–${row.next_seq}`,
    },
    {
      key: 'message_count',
      title: t('invocations.contexts.columns.messages'),
      align: 'right',
      width: 96,
      render: (row) => formatNumber(row.message_count),
    },
    {
      key: 'send_count_total',
      title: t('invocations.contexts.columns.sends'),
      align: 'right',
      width: 88,
      render: (row) => formatNumber(row.send_count_total),
    },
    {
      key: 'active_invocation',
      title: t('invocations.contexts.columns.activeSession'),
      width: 128,
      render: (row) =>
        row.active_invocation_id === null ? (
          <span className={css({ color: 'text-muted' })}>—</span>
        ) : (
          <AppLink to="/invocations/$invocationId" params={{ invocationId: row.active_invocation_id }}>
            {row.active_invocation_id}
          </AppLink>
        ),
    },
    {
      key: 'last_active_at',
      title: t('invocations.contexts.columns.lastActive'),
      width: 184,
      skeleton: '2026-01-18 10:58:15',
      render: (row) => <TimeText value={row.last_active_at} />,
    },
    {
      key: 'last_gc_at',
      title: t('invocations.contexts.columns.lastGc'),
      width: 184,
      skeleton: '2026-01-18 10:58:15',
      render: (row) => <TimeText value={row.last_gc_at} />,
    },
  ];

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <ListPageHeader title={t('layout.nav.contexts')} />
      <ListSearchForm value={query.value} emptyValue={EMPTY_FILTERS} onSearch={query.apply}>
        {({ draft, change }) => <ChatFilter value={draft.chat} onChange={(chat) => change({ chat })} />}
      </ListSearchForm>
      <SnapshotList
        factory={conversationContextsQuery}
        filters={filters}
        noticeTitle={(count) => t('invocations.contexts.newActivity', { count })}
        noticeAction={t('invocations.contexts.showNewActivity')}
        renderItems={(items, { loading }) => (
          <TableShell
            columns={COLUMNS}
            data={items}
            rowKey={(row) => row.conversation_id}
            loading={loading}
            minWidth={1040}
            emptyText={t('invocations.contexts.empty.title')}
            emptyDescription={t('invocations.contexts.empty.description')}
          />
        )}
      />
    </div>
  );
}
