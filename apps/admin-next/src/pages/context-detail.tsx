import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
  type ColumnSpec,
  DetailError,
  DetailSkeleton,
  JsonViewer,
  KvList,
  MonoValue,
  TableShell,
  TextValue,
  ToneBadge,
} from '@/components/business';
import { ToolResult } from '@/components/invocations/tool-result';
import { Panel } from '@/components/layout/panel';
import { Empty } from '@tuuject/koi-react/empty';
import type {
  ConversationContextDetail,
  ConversationContextMessageEntry,
  ConversationContextRefEntry,
} from '@/lib/api/contexts.ts';
import { formatNumber, formatTime } from '@/lib/format';
import { conversationContextQuery } from '@/lib/queries';
import { css } from '@tuuject/koi-react/styled-system/css';

function RoleBadge({ role }: { readonly role: string }): React.ReactElement {
  return <ToneBadge tone="neutral">{role}</ToneBadge>;
}

function CheckpointBadge({ isCheckpoint }: { readonly isCheckpoint: boolean }): React.ReactElement {
  const { t } = useTranslation();
  if (!isCheckpoint) {
    return <span className={css({ color: 'text-muted' })}>—</span>;
  }
  return <ToneBadge tone="info">{t('invocations.contextDetail.checkpoint')}</ToneBadge>;
}

function InvocationLink({ id }: { readonly id: string | null }): React.ReactElement {
  if (id === null) {
    return <span className={css({ color: 'text-muted' })}>—</span>;
  }
  return (
    <Link
      to="/invocations/$invocationId"
      params={{ invocationId: id }}
      className={css({
        textStyle: 'small',
        fontFamily: 'mono',
        wordBreak: 'break-all',
        textUnderlineOffset: '4px',
        _hover: { textDecorationLine: 'underline' },
      })}
    >
      {id}
    </Link>
  );
}

function RetainedMessages({ context }: { readonly context: ConversationContextDetail }): React.ReactElement {
  const { t } = useTranslation();
  if (context.messages.length === 0) {
    return (
      <Empty
        variant="plain"
        title={t('invocations.contextDetail.emptyMessages.title')}
        description={t('invocations.contextDetail.emptyMessages.description')}
      />
    );
  }
  const MESSAGE_COLUMNS: readonly ColumnSpec<ConversationContextMessageEntry>[] = [
    {
      key: 'seq',
      title: t('invocations.contextDetail.messageColumns.seq'),
      align: 'right',
      width: 70,
      render: (row) => String(row.seq),
    },
    {
      key: 'role',
      title: t('invocations.contextDetail.messageColumns.role'),
      render: (row) => <RoleBadge role={row.role} />,
    },
    {
      key: 'checkpoint',
      title: t('invocations.contextDetail.messageColumns.checkpoint'),
      render: (row) => <CheckpointBadge isCheckpoint={row.is_checkpoint} />,
    },
    {
      key: 'send_seq',
      title: t('invocations.contextDetail.messageColumns.sendSeq'),
      align: 'right',
      render: (row) =>
        row.send_seq === null ? <span className={css({ color: 'text-muted' })}>—</span> : String(row.send_seq),
    },
    {
      key: 'est_tokens',
      title: t('invocations.contextDetail.messageColumns.estTokens'),
      align: 'right',
      render: (row) => formatNumber(row.est_tokens),
    },
    {
      key: 'invocation',
      title: t('invocations.contextDetail.messageColumns.session'),
      render: (row) => <InvocationLink id={row.invocation_id} />,
    },
    {
      key: 'evicted_at',
      title: t('invocations.contextDetail.messageColumns.evicted'),
      render: (row) => formatTime(row.evicted_at),
    },
    {
      key: 'created_at',
      title: t('invocations.contextDetail.messageColumns.created'),
      render: (row) => formatTime(row.created_at),
    },
  ];
  return (
    <TableShell
      columns={MESSAGE_COLUMNS}
      data={context.messages}
      rowKey={(row) => String(row.seq)}
      expandedRender={(row) => (
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
          <p className={css({ textStyle: 'small', color: 'text-muted' })}>
            {t('invocations.contextDetail.payloadPreview')}
          </p>
          {row.result_content ? <ToolResult content={row.result_content} /> : null}
          <JsonViewer value={row.payload_preview} />
          {row.payload_truncated ? (
            <p className={css({ textStyle: 'small', color: 'text-muted' })}>
              {t('invocations.contextDetail.previewTruncated')}
            </p>
          ) : null}
        </div>
      )}
    />
  );
}

function CapabilityRefs({ context }: { readonly context: ConversationContextDetail }): React.ReactElement {
  const { t } = useTranslation();
  if (context.refs.length === 0) {
    return (
      <Empty
        variant="plain"
        title={t('invocations.contextDetail.emptyRefs.title')}
        description={t('invocations.contextDetail.emptyRefs.description')}
      />
    );
  }
  const REF_COLUMNS: readonly ColumnSpec<ConversationContextRefEntry>[] = [
    {
      key: 'ref',
      title: t('invocations.contextDetail.refColumns.ref'),
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
          {row.ref}
        </code>
      ),
    },
    {
      key: 'kind',
      title: t('invocations.contextDetail.refColumns.kind'),
      render: (row) => <RoleBadge role={row.kind} />,
    },
    {
      key: 'source_seq',
      title: t('invocations.contextDetail.refColumns.sourceSeq'),
      align: 'right',
      render: (row) => String(row.source_seq),
    },
    {
      key: 'expires_at',
      title: t('invocations.contextDetail.refColumns.expires'),
      render: (row) => formatTime(row.expires_at),
    },
  ];
  return <TableShell columns={REF_COLUMNS} data={context.refs} rowKey={(row) => row.ref} />;
}

export function ContextDetailView({ id }: { readonly id: string }): React.ReactElement {
  const { t } = useTranslation();
  const { data, isPending, isError, error } = useQuery(conversationContextQuery(id));

  if (isPending) {
    return <DetailSkeleton />;
  }
  if (isError) {
    return (
      <DetailError
        error={error}
        notFoundTitle={t('invocations.contextDetail.notFound')}
        failedTitle={t('invocations.contextDetail.loadFailed')}
        backTo="/contexts"
        backLabel={t('invocations.contextDetail.backToContexts')}
      />
    );
  }
  if (data === undefined) {
    return (
      <DetailError
        error={new Error(t('invocations.contextDetail.dataMissing'))}
        notFoundTitle={t('invocations.contextDetail.notFound')}
        failedTitle={t('invocations.contextDetail.loadFailed')}
        backTo="/contexts"
        backLabel={t('invocations.contextDetail.backToContexts')}
      />
    );
  }

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
      <Panel
        title={t('invocations.contextDetail.title', { id: data.conversation_id })}
        action={
          <Link
            to="/contexts"
            className={css({
              textStyle: 'body',
              color: 'text-brand',
              flexShrink: '0',
              textUnderlineOffset: '4px',
              _hover: { textDecorationLine: 'underline' },
            })}
          >
            {t('invocations.contextDetail.backToList')}
          </Link>
        }
      >
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
          <KvList
            items={[
              {
                label: t('invocations.contextDetail.kv.conversationId'),
                value: <MonoValue value={data.conversation_id} />,
              },
              {
                label: t('invocations.contextDetail.kv.chat'),
                value: <TextValue value={data.chat_title ?? data.telegram_chat_id} />,
              },
              { label: t('invocations.contextDetail.kv.chatId'), value: <MonoValue value={data.telegram_chat_id} /> },
              { label: t('invocations.contextDetail.kv.chatType'), value: <TextValue value={data.chat_type} /> },
              { label: t('invocations.contextDetail.kv.topic'), value: String(data.message_thread_id) },
              { label: t('invocations.contextDetail.kv.sendsTotal'), value: formatNumber(data.send_count_total) },
              { label: t('invocations.contextDetail.kv.headSeq'), value: formatNumber(data.head_seq) },
              { label: t('invocations.contextDetail.kv.nextSeq'), value: formatNumber(data.next_seq) },
              { label: t('invocations.contextDetail.kv.retainedMessages'), value: formatNumber(data.message_count) },
              { label: t('invocations.contextDetail.kv.lastActive'), value: formatTime(data.last_active_at) },
              { label: t('invocations.contextDetail.kv.lastGc'), value: formatTime(data.last_gc_at) },
              {
                label: t('invocations.contextDetail.kv.activeSession'),
                value: <InvocationLink id={data.active_invocation_id} />,
              },
              {
                label: t('invocations.contextDetail.kv.systemPromptHash'),
                value: <MonoValue value={data.system_prompt_hash} />,
              },
              { label: t('invocations.contextDetail.kv.created'), value: formatTime(data.created_at) },
              { label: t('invocations.contextDetail.kv.updated'), value: formatTime(data.updated_at) },
            ]}
          />
        </div>
      </Panel>
      <Panel title={t('invocations.contextDetail.messagesTitle', { count: data.messages.length })}>
        <div>
          <RetainedMessages context={data} />
        </div>
      </Panel>
      <Panel title={t('invocations.contextDetail.refsTitle', { count: data.refs.length })}>
        <div>
          <CapabilityRefs context={data} />
        </div>
      </Panel>
    </div>
  );
}
