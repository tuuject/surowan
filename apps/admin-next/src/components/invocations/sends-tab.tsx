import type React from 'react';
import { useTranslation } from 'react-i18next';
import { type ColumnSpec, JsonViewer, MonoValue, StateBadge, TableShell, TextValue } from '@/components/business';
import { isRoom, TabContent } from '@/components/invocations/shared';

import { formatTime } from '@/lib/format';
import type { InvocationDetail, TelegramSendEntry } from '@/lib/api/invocations.ts';

export function SendsTab({ invocation }: { readonly invocation: InvocationDetail }): React.ReactNode {
  const { t } = useTranslation();
  const room = isRoom(invocation.chat);
  const SEND_COLUMNS: readonly ColumnSpec<TelegramSendEntry>[] = [
    { key: 'kind', title: t('invocations.invocationDetail.sendColumns.kind'), render: (row) => row.kind },
    {
      key: 'state',
      title: t('invocations.invocationDetail.sendColumns.state'),
      render: (row) => <StateBadge state={row.state} />,
    },
    room
      ? {
          key: 'message',
          title: t('invocations.invocationDetail.sendColumns.roomMessage'),
          render: (row) => <TextValue value={row.room_seq === null ? null : `#${row.room_seq}`} />,
        }
      : {
          key: 'message',
          title: t('invocations.invocationDetail.sendColumns.telegramMessage'),
          render: (row) => <TextValue value={row.telegram_message_id} />,
        },
    {
      key: 'tool-call',
      title: t('invocations.invocationDetail.sendColumns.toolCall'),
      render: (row) => <MonoValue value={row.tool_call_id} />,
    },
    {
      key: 'error',
      title: t('invocations.invocationDetail.sendColumns.error'),
      render: (row) => <TextValue value={row.error_code} />,
    },
    {
      key: 'created',
      title: t('invocations.invocationDetail.sendColumns.created'),
      render: (row) => formatTime(row.created_at),
    },
  ];
  return (
    <TabContent
      count={invocation.telegram_sends.length}
      message={t(
        room ? 'invocations.invocationDetail.emptyRoomSends' : 'invocations.invocationDetail.emptyTelegramSends',
      )}
    >
      <TableShell
        columns={SEND_COLUMNS}
        data={invocation.telegram_sends}
        rowKey={(row) => row.id}
        expandedRender={(row) => (
          <div>
            <p className="text-muted-foreground mb-1 text-xs">{t('invocations.invocationDetail.requestPayload')}</p>
            <JsonViewer value={row.request_json} />
          </div>
        )}
      />
    </TabContent>
  );
}
