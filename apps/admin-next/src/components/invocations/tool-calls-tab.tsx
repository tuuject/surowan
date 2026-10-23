import type React from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ColumnSpec,
  JsonViewer,
  KvList,
  MonoValue,
  StateBadge,
  TableShell,
  TextValue,
} from '@/components/business';
import { TabContent, YesNoBadge } from '@/components/invocations/shared';

import { formatDuration, formatTime } from '@/lib/format';
import { parseSendArguments } from '@/lib/timeline';
import type { InvocationDetail, ToolCallEntry } from '@/lib/api/invocations.ts';

function SendArgumentsSummary({ argumentsJson }: { readonly argumentsJson: string }): React.ReactElement {
  const { t } = useTranslation();
  const parsed = parseSendArguments(argumentsJson);
  return (
    <div className="mb-2">
      <p className="text-muted-foreground mb-1 text-xs">{t('invocations.invocationDetail.sendArguments.title')}</p>
      <KvList
        className="sm:grid-cols-2 lg:grid-cols-4"
        items={[
          { label: t('invocations.invocationDetail.sendArguments.kind'), value: <TextValue value={parsed.kind} /> },
          { label: t('invocations.invocationDetail.sendArguments.text'), value: <TextValue value={parsed.text} /> },
          {
            label: t('invocations.invocationDetail.sendArguments.stickerRef'),
            value: <TextValue value={parsed.sticker_ref} />,
          },
          {
            label: t('invocations.invocationDetail.sendArguments.replyToMessage'),
            value: <TextValue value={parsed.reply_to_message_id} />,
          },
        ]}
      />
    </div>
  );
}

export function ToolCallsTab({ invocation }: { readonly invocation: InvocationDetail }): React.ReactNode {
  const { t } = useTranslation();
  const TOOL_CALL_COLUMNS: readonly ColumnSpec<ToolCallEntry>[] = [
    {
      key: 'tool',
      title: t('invocations.invocationDetail.toolColumns.tool'),
      render: (row) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{row.tool_name}</code>,
    },
    {
      key: 'call-id',
      title: t('invocations.invocationDetail.toolColumns.callId'),
      render: (row) => <MonoValue value={row.tool_call_id} />,
    },
    {
      key: 'state',
      title: t('invocations.invocationDetail.toolColumns.state'),
      render: (row) => <StateBadge state={row.state} />,
    },
    {
      key: 'side-effect',
      title: t('invocations.invocationDetail.toolColumns.sideEffect'),
      render: (row) => <YesNoBadge value={row.side_effect} />,
    },
    {
      key: 'error',
      title: t('invocations.invocationDetail.toolColumns.error'),
      render: (row) => <TextValue value={row.error_code} />,
    },
    {
      key: 'duration',
      title: t('invocations.invocationDetail.toolColumns.duration'),
      align: 'right',
      render: (row) => formatDuration(row.duration_ms),
    },
    {
      key: 'created',
      title: t('invocations.invocationDetail.toolColumns.created'),
      render: (row) => formatTime(row.created_at),
    },
  ];
  return (
    <TabContent count={invocation.tool_calls.length} message={t('invocations.invocationDetail.emptyToolCalls')}>
      <TableShell
        columns={TOOL_CALL_COLUMNS}
        data={invocation.tool_calls}
        rowKey={(row) => row.id}
        expandedRender={(row) => (
          <div className="space-y-3">
            {row.tool_name === 'send' ? <SendArgumentsSummary argumentsJson={row.arguments_json} /> : null}
            <div>
              <p className="text-muted-foreground mb-1 text-xs">
                {t('invocations.invocationDetail.toolCall.arguments')}
              </p>
              <JsonViewer value={row.arguments_json} />
            </div>
            <div>
              <p className="text-muted-foreground mb-1 text-xs">{t('invocations.invocationDetail.toolCall.result')}</p>
              <JsonViewer value={row.result_text} />
            </div>
          </div>
        )}
      />
    </TabContent>
  );
}
