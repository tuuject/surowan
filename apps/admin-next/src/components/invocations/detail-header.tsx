import { Link } from '@tanstack/react-router';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ColumnSpec,
  KvList,
  LazyDetails,
  MonoValue,
  StateBadge,
  TableShell,
  TextValue,
} from '@/components/business';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import { formatCost, formatNumber, formatTime } from '@/lib/format';
import type { InvocationDetail, ToolRegistryEntry } from '@/lib/api/invocations.ts';

function ToolRegistryTable({ registry }: { readonly registry: readonly ToolRegistryEntry[] }): React.ReactElement {
  const { t } = useTranslation();
  const columns: readonly ColumnSpec<ToolRegistryEntry>[] = [
    {
      key: 'name',
      title: t('invocations.invocationDetail.toolRegistry.name'),
      render: (row) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{row.name}</code>,
    },
    { key: 'label', title: t('invocations.invocationDetail.toolRegistry.label'), render: (row) => row.label },
    {
      key: 'description',
      title: t('invocations.invocationDetail.toolRegistry.description'),
      className: 'min-w-64 max-w-2xl',
      render: (row) => <p className="max-w-2xl text-sm break-words">{row.description}</p>,
    },
  ];
  return (
    <LazyDetails
      summaryClassName="text-muted-foreground flex cursor-pointer items-center gap-2 text-sm"
      contentClassName="mt-2"
      summary={
        <>
          {t('invocations.invocationDetail.toolRegistry.title')}
          <span className="text-xs">{t('invocations.invocationDetail.toolRegistry.subtitle')}</span>
        </>
      }
    >
      <TableShell columns={columns} data={registry} rowKey={(row) => row.name} />
    </LazyDetails>
  );
}

export function DetailHeader({ invocation }: { readonly invocation: InvocationDetail }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <Card className="gap-4 py-5">
      <CardHeader className="flex-row items-start justify-between gap-4 px-5 py-0">
        <CardTitle className="font-mono text-base break-all">
          {t('invocations.invocationDetail.title', { id: invocation.id })}
        </CardTitle>
        <Link to="/invocations" className="text-primary shrink-0 text-sm underline-offset-4 hover:underline">
          {t('invocations.invocationDetail.backToList')}
        </Link>
      </CardHeader>
      <CardContent className="space-y-4 px-5 py-0">
        <KvList
          items={[
            { label: t('invocations.invocationDetail.kv.state'), value: <StateBadge state={invocation.state} /> },
            {
              label: t('invocations.invocationDetail.kv.completionReason'),
              value: <TextValue value={invocation.completion_reason} />,
            },
            {
              label: t('invocations.invocationDetail.kv.errorCode'),
              value: <TextValue value={invocation.error_code} />,
            },
            {
              label: t('invocations.invocationDetail.kv.chat'),
              value: (
                <TextValue
                  value={invocation.chat.title ?? invocation.chat.telegram_chat_id ?? invocation.chat.room_id}
                />
              ),
            },
            invocation.chat.room_id === null
              ? {
                  label: t('invocations.invocationDetail.kv.chatId'),
                  value: <MonoValue value={invocation.chat.telegram_chat_id} />,
                }
              : {
                  label: t('invocations.invocationDetail.kv.room'),
                  value: (
                    <Link
                      to="/playground"
                      search={{ room: invocation.chat.room_id }}
                      className="text-primary font-mono text-xs underline-offset-4 hover:underline"
                    >
                      {invocation.chat.room_id}
                    </Link>
                  ),
                },
            { label: t('invocations.invocationDetail.kv.topic'), value: String(invocation.chat.message_thread_id) },
            { label: t('invocations.invocationDetail.kv.bucket'), value: <MonoValue value={invocation.bucket_id} /> },
            { label: t('invocations.invocationDetail.kv.created'), value: formatTime(invocation.created_at) },
            { label: t('invocations.invocationDetail.kv.started'), value: formatTime(invocation.started_at) },
            { label: t('invocations.invocationDetail.kv.finished'), value: formatTime(invocation.finished_at) },
            { label: t('invocations.invocationDetail.kv.tokens'), value: formatNumber(invocation.total_tokens) },
            {
              label: t('invocations.invocationDetail.kv.cacheRead'),
              value: formatNumber(invocation.cache_read_tokens),
            },
            {
              label: t('invocations.invocationDetail.kv.cacheWrite'),
              value: formatNumber(invocation.cache_write_tokens),
            },
            { label: t('invocations.invocationDetail.kv.cost'), value: formatCost(invocation.total_cost) },
            {
              label: t('invocations.invocationDetail.kv.configHash'),
              value: <MonoValue value={invocation.config_hash.slice(0, 16)} />,
            },
            { label: t('invocations.invocationDetail.kv.promptVersion'), value: String(invocation.prompt_version) },
            {
              label: t('invocations.invocationDetail.kv.toolRegistryHash'),
              value: <TextValue value={invocation.tool_registry_hash} />,
            },
          ]}
        />
        {invocation.tool_registry !== null && invocation.tool_registry.length > 0 ? (
          <ToolRegistryTable registry={invocation.tool_registry} />
        ) : null}
      </CardContent>
    </Card>
  );
}
