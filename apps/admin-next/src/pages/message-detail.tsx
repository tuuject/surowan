import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
  type ColumnSpec,
  CopyableValue,
  DetailError,
  DetailSkeleton,
  JsonViewer,
  KvList,
  MonoValue,
  TableShell,
  TextValue,
  ToneBadge,
} from '@/components/business';
import { Panel } from '@/components/layout/panel';
import type { MediaEntry, MessageDetail, RevisionEntry } from '@/lib/api/messages.ts';
import { formatNumber, formatTime } from '@/lib/format';
import { messageQuery } from '@/lib/queries';
import { css } from '@tuuject/koi-react/styled-system/css';

function YesNoBadge({ value }: { readonly value: boolean }): React.ReactElement {
  const { t } = useTranslation();
  return value ? (
    <ToneBadge tone="success">{t('invocations.messageDetail.yes')}</ToneBadge>
  ) : (
    <ToneBadge tone="neutral">{t('invocations.messageDetail.no')}</ToneBadge>
  );
}

function DetailHeader({ message }: { readonly message: MessageDetail }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <Panel
      title={t('invocations.messageDetail.title', { id: message.id })}
      action={
        <Link
          to="/messages"
          className={css({
            textStyle: 'body',
            color: 'text-brand',
            flexShrink: '0',
            textUnderlineOffset: '4px',
            _hover: { textDecorationLine: 'underline' },
          })}
        >
          {t('invocations.messageDetail.backToList')}
        </Link>
      }
    >
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
        <KvList
          items={[
            {
              label: t('invocations.messageDetail.kv.telegramMessageId'),
              value: <MonoValue value={message.telegram_message_id} />,
            },
            {
              label: t('invocations.messageDetail.kv.chat'),
              value: <TextValue value={message.chat.title ?? message.chat.telegram_chat_id} />,
            },
            {
              label: t('invocations.messageDetail.kv.chatId'),
              value: <MonoValue value={message.chat.telegram_chat_id} />,
            },
            { label: t('invocations.messageDetail.kv.chatType'), value: <TextValue value={message.chat.type} /> },
            { label: t('invocations.messageDetail.kv.topic'), value: String(message.chat.message_thread_id) },
            { label: t('invocations.messageDetail.kv.visible'), value: <YesNoBadge value={message.visible} /> },
            { label: t('invocations.messageDetail.kv.sentByBot'), value: <YesNoBadge value={message.sent_by_bot} /> },
            { label: t('invocations.messageDetail.kv.telegramDate'), value: formatTime(message.telegram_date) },
            { label: t('invocations.messageDetail.kv.received'), value: formatTime(message.received_at) },
          ]}
        />
      </div>
    </Panel>
  );
}

function RevisionsTable({ message }: { readonly message: MessageDetail }): React.ReactElement {
  const { t } = useTranslation();
  const REVISION_COLUMNS: readonly ColumnSpec<RevisionEntry>[] = [
    {
      key: 'revision_no',
      title: t('invocations.messageDetail.revisionColumns.sequence'),
      align: 'right',
      width: 60,
      render: (row) => String(row.revision_no),
    },
    { key: 'kind', title: t('invocations.messageDetail.revisionColumns.kind'), render: (row) => row.kind },
    {
      key: 'sender',
      title: t('invocations.messageDetail.revisionColumns.sender'),
      render: (row) => (
        <div className={css({ minWidth: '0', '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          <TextValue value={row.sender?.display_name ?? null} />
          {row.sender === null ? null : (
            <CopyableValue
              label={t(row.sender.telegram_type === 'sender_chat' ? 'common.telegramChatId' : 'common.telegramUserId')}
              value={row.sender.telegram_id}
            />
          )}
        </div>
      ),
    },
    {
      key: 'text',
      title: t('invocations.messageDetail.revisionColumns.text'),
      className: 'min-w-72 max-w-2xl whitespace-normal',
      render: (row) => (
        <p className={css({ textStyle: 'body', maxWidth: '42rem', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' })}>
          {row.text ?? row.caption ?? '—'}
        </p>
      ),
    },
    {
      key: 'reply_to_message_id',
      title: t('invocations.messageDetail.revisionColumns.replyTo'),
      render: (row) => <TextValue value={row.reply_to_message_id} />,
    },
    {
      key: 'created_at',
      title: t('invocations.messageDetail.revisionColumns.created'),
      render: (row) => formatTime(row.created_at),
    },
  ];
  return (
    <TableShell
      columns={REVISION_COLUMNS}
      data={message.revisions}
      rowKey={(row) => row.id}
      emptyText={t('invocations.messageDetail.noRevisions')}
      expandedRender={(row) => (
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
          <div>
            <p className={css({ textStyle: 'small', color: 'text-muted', marginBlockEnd: '1' })}>
              {t('invocations.messageDetail.replySnapshot')}
            </p>
            <JsonViewer value={row.reply_snapshot_json} />
          </div>
          <div>
            <p className={css({ textStyle: 'small', color: 'text-muted', marginBlockEnd: '1' })}>
              {t('invocations.messageDetail.forwardOrigin')}
            </p>
            <JsonViewer value={row.forward_origin_json} />
          </div>
          <div>
            <p className={css({ textStyle: 'small', color: 'text-muted', marginBlockEnd: '1' })}>
              {t('invocations.messageDetail.servicePayload')}
            </p>
            <JsonViewer value={row.service_json} />
          </div>
        </div>
      )}
    />
  );
}

function MediaTable({ message }: { readonly message: MessageDetail }): React.ReactElement {
  const { t } = useTranslation();
  const MEDIA_COLUMNS: readonly ColumnSpec<MediaEntry>[] = [
    { key: 'kind', title: t('invocations.messageDetail.mediaColumns.kind'), render: (row) => row.kind },
    {
      key: 'file_unique_id',
      title: t('invocations.messageDetail.mediaColumns.fileUniqueId'),
      render: (row) => (
        <code
          className={css({
            textStyle: 'small',
            borderRadius: 'lg',
            bg: 'surface-muted',
            paddingInline: '1',
            paddingBlock: '1',
            fontFamily: 'mono',
            wordBreak: 'break-all',
          })}
        >
          {row.file_unique_id}
        </code>
      ),
    },
    {
      key: 'mime_type',
      title: t('invocations.messageDetail.mediaColumns.mime'),
      render: (row) => <TextValue value={row.mime_type} />,
    },
    {
      key: 'file_size',
      title: t('invocations.messageDetail.mediaColumns.size'),
      align: 'right',
      render: (row) => formatNumber(row.file_size),
    },
    {
      key: 'dimensions',
      title: t('invocations.messageDetail.mediaColumns.dimensions'),
      render: (row) =>
        row.width === null || row.height === null ? (
          <span className={css({ color: 'text-muted' })}>—</span>
        ) : (
          `${row.width}×${row.height}`
        ),
    },
    {
      key: 'analysis',
      title: t('invocations.messageDetail.mediaColumns.analysis'),
      className: 'min-w-56 max-w-md',
      render: (row) => <TextValue value={row.analysis_description ?? row.analysis_state} />,
    },
  ];
  return (
    <TableShell
      columns={MEDIA_COLUMNS}
      data={message.media}
      rowKey={(row) => row.id}
      emptyText={t('invocations.messageDetail.noMedia')}
    />
  );
}

export function MessageDetailView({ id }: { readonly id: string }): React.ReactElement {
  const { t } = useTranslation();
  const { data, isPending, isError, error } = useQuery(messageQuery(id));

  if (isPending) {
    return <DetailSkeleton />;
  }
  if (isError) {
    return (
      <DetailError
        error={error}
        notFoundTitle={t('invocations.messageDetail.notFound')}
        failedTitle={t('invocations.messageDetail.loadFailed')}
        backTo="/messages"
        backLabel={t('invocations.messageDetail.backToMessages')}
      />
    );
  }
  if (data === undefined) {
    return (
      <DetailError
        error={new Error(t('invocations.messageDetail.dataMissing'))}
        notFoundTitle={t('invocations.messageDetail.notFound')}
        failedTitle={t('invocations.messageDetail.loadFailed')}
        backTo="/messages"
        backLabel={t('invocations.messageDetail.backToMessages')}
      />
    );
  }

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
      <DetailHeader message={data} />
      <Panel title={t('invocations.messageDetail.revisionsTitle', { count: data.revisions.length })}>
        <div>
          <RevisionsTable message={data} />
        </div>
      </Panel>
      <Panel title={t('invocations.messageDetail.mediaTitle', { count: data.media.length })}>
        <div>
          <MediaTable message={data} />
        </div>
      </Panel>
    </div>
  );
}
