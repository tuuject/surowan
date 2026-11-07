import { css } from '@tuuject/koi-react/styled-system/css';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChatFilter,
  type ColumnSpec,
  CopyableValue,
  CursorList,
  ListPageHeader,
  ListSearchForm,
  QueryTextField,
  TableShell,
  ToneBadge,
} from '@/components/business';
import { AppLink } from '@/components/router-links';
import type { MessageListItem } from '@/lib/api/messages.ts';
import { formatNumber, formatTime } from '@/lib/format';
import { chatQuery, optionalQuery, useListQuery } from '@/lib/list-query';
import { messagesQuery } from '@/lib/queries';

const EMPTY_FILTERS = { search: '', chat: '' };

/** Text or caption; non-text kinds carry a neutral kind badge so a sticker row isn't just a dash. */
function MessageCell({ row }: { readonly row: MessageListItem }): React.ReactElement {
  const body = row.text ?? row.caption;
  const showKind = row.kind !== null && row.kind !== 'text';
  if (body === null && !showKind) {
    return <span className={css({ color: 'text-muted' })}>—</span>;
  }
  return (
    <div className={css({ display: 'flex', minWidth: '0', alignItems: 'flex-start', gap: '2' })}>
      {showKind ? <ToneBadge tone="neutral">{row.kind}</ToneBadge> : null}
      {body === null ? null : (
        <p className={css({ margin: '0', lineClamp: '2', whiteSpace: 'normal', overflowWrap: 'anywhere' })}>{body}</p>
      )}
    </div>
  );
}

export default function MessagesPage(): React.ReactElement {
  const { t } = useTranslation();
  const query = useListQuery(EMPTY_FILTERS);
  const { search, chat } = query.value;
  const filters = useMemo(() => ({ search: optionalQuery(search), chat: chatQuery(chat) }), [search, chat]);

  const COLUMNS: readonly ColumnSpec<MessageListItem>[] = [
    {
      key: 'id',
      title: t('invocations.messages.columns.id'),
      width: 88,
      skeleton: '1024',
      render: (row) => (
        <AppLink to="/messages/$messageId" params={{ messageId: row.id }}>
          {row.id}
        </AppLink>
      ),
    },
    {
      key: 'chat',
      title: t('invocations.messages.columns.chat'),
      render: (row) => (
        <div className={css({ minWidth: '0' })}>
          <div className={css({ truncate: true })}>{row.chat.title ?? row.chat.telegram_chat_id}</div>
          <div className={css({ display: 'flex', gap: '2', textStyle: 'small', color: 'text-muted' })}>
            <span>{row.chat.type}</span>
            {row.chat.message_thread_id === 0 ? null : (
              <span>{t('invocations.invocations.topicLabel', { id: row.chat.message_thread_id })}</span>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'sender',
      title: t('invocations.messages.columns.sender'),
      render: (row) =>
        row.sender === null ? (
          row.sent_by_bot ? (
            <ToneBadge tone="neutral">bot</ToneBadge>
          ) : (
            <span className={css({ color: 'text-muted' })}>—</span>
          )
        ) : (
          <div className={css({ minWidth: '0', '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
            <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
              <span className={css({ overflowWrap: 'anywhere' })}>{row.sender.display_name}</span>
              {row.sender.is_bot === true ? <ToneBadge tone="neutral">bot</ToneBadge> : null}
            </div>
            <CopyableValue
              label={t(row.sender.telegram_type === 'sender_chat' ? 'common.telegramChatId' : 'common.telegramUserId')}
              value={row.sender.telegram_id}
            />
          </div>
        ),
    },
    {
      key: 'text',
      title: t('invocations.messages.columns.message'),
      render: (row) => <MessageCell row={row} />,
    },
    {
      key: 'revision_count',
      title: t('invocations.messages.columns.revisions'),
      align: 'right',
      width: 88,
      render: (row) => formatNumber(row.revision_count),
    },
    {
      key: 'media_count',
      title: t('invocations.messages.columns.media'),
      align: 'right',
      width: 80,
      render: (row) => formatNumber(row.media_count),
    },
    {
      key: 'telegram_message_id',
      title: t('invocations.messages.columns.telegramId'),
      width: 136,
      render: (row) => row.telegram_message_id,
    },
    {
      key: 'received_at',
      title: t('invocations.messages.columns.received'),
      width: 184,
      skeleton: '2026-01-18 10:58:15',
      render: (row) => formatTime(row.received_at),
    },
  ];

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <ListPageHeader title={t('layout.nav.messages')} />
      <ListSearchForm value={query.value} emptyValue={EMPTY_FILTERS} onSearch={query.apply}>
        {({ draft, change }) => (
          <>
            <QueryTextField
              label={t('invocations.messages.searchPlaceholder')}
              value={draft.search}
              onChange={(search) => change({ search })}
            />
            <ChatFilter value={draft.chat} onChange={(chat) => change({ chat })} />
          </>
        )}
      </ListSearchForm>
      <CursorList
        factory={messagesQuery}
        filters={filters}
        renderItems={(items, { loading }) => (
          <TableShell
            columns={COLUMNS}
            data={items}
            rowKey={(row) => row.id}
            loading={loading}
            minWidth={1040}
            emptyText={t('invocations.messages.empty.title')}
            emptyDescription={t('invocations.messages.empty.description')}
          />
        )}
      />
    </div>
  );
}
