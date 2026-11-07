import { Link } from '@tanstack/react-router';
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
import type { MessageListItem } from '@/lib/api/messages.ts';
import { formatNumber, formatTime } from '@/lib/format';
import { chatQuery, optionalQuery, useListQuery } from '@/lib/list-query';
import { messagesQuery } from '@/lib/queries';
import { css } from '@tuuject/koi-react/styled-system/css';

const ID_LINK =
  'decoration-border hover:decoration-foreground font-medium tabular-nums underline underline-offset-4 transition-colors';
const EMPTY_FILTERS = { search: '', chat: '' };

/** Text or caption; non-text kinds carry a neutral kind badge so a sticker row isn't just a dash. */
function MessageCell({ row }: { readonly row: MessageListItem }): React.ReactElement {
  const body = row.text ?? row.caption;
  const showKind = row.kind !== null && row.kind !== 'text';
  if (body === null && !showKind) {
    return <span className={css({ color: 'text-muted' })}>—</span>;
  }
  return (
    <div className={css({ display: 'flex', maxWidth: '28rem', alignItems: 'flex-start', gap: '2' })}>
      {showKind ? <ToneBadge tone="neutral">{row.kind}</ToneBadge> : null}
      {body === null ? null : <p className={css({ lineClamp: '2', overflowWrap: 'anywhere' })}>{body}</p>}
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
      render: (row) => (
        <Link to="/messages/$messageId" params={{ messageId: row.id }} className={ID_LINK}>
          {row.id}
        </Link>
      ),
    },
    {
      key: 'chat',
      title: t('invocations.messages.columns.chat'),
      className: 'min-w-40',
      render: (row) => (
        <div className={css({ minWidth: '0', '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          <div className={css({ textStyle: 'label', overflowWrap: 'anywhere' })}>
            {row.chat.title ?? row.chat.telegram_chat_id}
          </div>
          <div className={css({ textStyle: 'small', color: 'text-muted' })}>
            {row.chat.type}
            {row.chat.message_thread_id === 0 ? '' : ` · topic ${row.chat.message_thread_id}`}
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
      className: 'min-w-72 whitespace-normal',
      render: (row) => <MessageCell row={row} />,
    },
    {
      key: 'revision_count',
      title: t('invocations.messages.columns.revisions'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => formatNumber(row.revision_count),
    },
    {
      key: 'media_count',
      title: t('invocations.messages.columns.media'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => formatNumber(row.media_count),
    },
    {
      key: 'telegram_message_id',
      title: t('invocations.messages.columns.telegramId'),
      className: 'text-muted-foreground ps-6 tabular-nums',
      render: (row) => row.telegram_message_id,
    },
    {
      key: 'received_at',
      title: t('invocations.messages.columns.received'),
      className: 'text-muted-foreground',
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
            emptyText={t('invocations.messages.empty.title')}
            emptyDescription={t('invocations.messages.empty.description')}
          />
        )}
      />
    </div>
  );
}
