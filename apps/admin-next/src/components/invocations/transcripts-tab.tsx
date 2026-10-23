import type React from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ColumnSpec,
  CopyableValue,
  JsonViewer,
  LazyDetails,
  MonoValue,
  PrivateReasoningNote,
  PrivateReasoningTag,
  TableShell,
  TextValue,
} from '@/components/business';
import { isRoom, MessageRecordLink, RoleBadge, SectionBadge, TabContent } from '@/components/invocations/shared';

import { formatTime } from '@/lib/format';
import { objectField, parseJsonObject, stringField } from '@/lib/timeline';
import type { AgentMessageEntry, InvocationDetail } from '@/lib/api/invocations.ts';
import type { ContextMessageEntry } from '@/lib/api/contexts.ts';

export function AgentTranscriptTab({ invocation }: { readonly invocation: InvocationDetail }): React.ReactNode {
  const { t } = useTranslation();
  const AGENT_COLUMNS: readonly ColumnSpec<AgentMessageEntry>[] = [
    {
      key: 'sequence',
      title: t('invocations.invocationDetail.agentColumns.sequence'),
      align: 'right',
      width: 60,
      render: (row) => String(row.sequence_no),
    },
    {
      key: 'role',
      title: t('invocations.invocationDetail.agentColumns.role'),
      render: (row) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <RoleBadge role={row.role} />
          {row.role === 'assistant' ? <PrivateReasoningTag /> : null}
        </div>
      ),
    },
    {
      key: 'text',
      title: t('invocations.invocationDetail.agentColumns.text'),
      className: 'min-w-64 max-w-2xl whitespace-normal',
      render: (row) => (
        <div className="space-y-1">
          {row.thinking_text.length > 0 && row.role === 'assistant' ? (
            <LazyDetails
              summary={t('invocations.invocationDetail.agent.thinkingLabel')}
              summaryClassName="text-muted-foreground cursor-pointer text-xs"
              contentClassName="text-sm break-words whitespace-pre-wrap"
            >
              {row.thinking_text}
            </LazyDetails>
          ) : null}
          {row.text.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('invocations.invocationDetail.agent.noText')}</p>
          ) : (
            <p className="text-sm break-words whitespace-pre-wrap">{row.text}</p>
          )}
        </div>
      ),
    },
    {
      key: 'created',
      title: t('invocations.invocationDetail.agentColumns.created'),
      render: (row) => formatTime(row.created_at),
    },
  ];
  return (
    <div className="space-y-3">
      <PrivateReasoningNote />
      <TabContent
        count={invocation.agent_messages.length}
        message={t('invocations.invocationDetail.emptyAgentMessages')}
      >
        <TableShell
          columns={AGENT_COLUMNS}
          data={invocation.agent_messages}
          rowKey={(row) => String(row.sequence_no)}
        />
      </TabContent>
    </div>
  );
}

export function FrozenContextTab({ invocation }: { readonly invocation: InvocationDetail }): React.ReactNode {
  const { t } = useTranslation();
  const CONTEXT_COLUMNS: readonly ColumnSpec<ContextMessageEntry>[] = [
    {
      key: 'section',
      title: t('invocations.invocationDetail.contextColumns.section'),
      render: (row) => <SectionBadge section={row.section} />,
    },
    {
      key: 'sequence',
      title: t('invocations.invocationDetail.contextColumns.sequence'),
      align: 'right',
      width: 60,
      render: (row) => String(row.sequence_no),
    },
    {
      key: 'message',
      title: t('invocations.invocationDetail.contextColumns.message'),
      render: (row) => (
        <MessageRecordLink
          chat={invocation.chat}
          messageId={row.message_id}
          className="font-mono text-xs break-all underline-offset-4 hover:underline"
        >
          {row.message_id}
        </MessageRecordLink>
      ),
    },
    {
      key: 'revision',
      title: t('invocations.invocationDetail.contextColumns.revision'),
      render: (row) => <MonoValue value={row.revision_id} />,
    },
    {
      key: 'sender',
      title: t('invocations.invocationDetail.contextColumns.sender'),
      render: (row) => {
        const sender = objectField(parseJsonObject(row.snapshot_json), 'sender');
        return (
          <div className="min-w-0 space-y-0.5">
            <TextValue value={stringField(sender, 'name') ?? stringField(sender, 'username')} />
            {isRoom(invocation.chat) ? (
              <CopyableValue
                label={t('invocations.invocationDetail.roomMemberRef')}
                value={stringField(sender, 'ref')}
              />
            ) : (
              <CopyableValue label={t('common.telegramSenderId')} value={stringField(sender, 'id')} />
            )}
          </div>
        );
      },
    },
    {
      key: 'omitted',
      title: t('invocations.invocationDetail.contextColumns.omittedBefore'),
      align: 'right',
      render: (row) => String(row.omitted_before),
    },
  ];
  return (
    <TabContent
      count={invocation.context_messages.length}
      message={t('invocations.invocationDetail.emptyContextMessages')}
    >
      <TableShell
        columns={CONTEXT_COLUMNS}
        data={invocation.context_messages}
        rowKey={(row) => `${row.section}-${row.sequence_no}`}
        expandedRender={(row) => (
          <div>
            <p className="text-muted-foreground mb-1 text-xs">{t('invocations.invocationDetail.snapshot')}</p>
            <JsonViewer value={row.snapshot_json} />
          </div>
        )}
      />
    </TabContent>
  );
}
