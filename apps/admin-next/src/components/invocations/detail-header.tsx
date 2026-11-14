import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ColumnSpec,
  KvList,
  LazyDetails,
  MonoValue,
  StateBadge,
  TableShell,
  TextValue,
  TimeText,
} from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { AppLink } from '@/components/router-links';
import type { InvocationDetail, ToolRegistryEntry } from '@/lib/api/invocations.ts';
import { formatCost, formatNumber } from '@/lib/format';

function ToolRegistryTable({ registry }: { readonly registry: readonly ToolRegistryEntry[] }): ReactElement {
  const { t } = useTranslation();
  const columns: readonly ColumnSpec<ToolRegistryEntry>[] = [
    {
      key: 'name',
      title: t('invocations.invocationDetail.toolRegistry.name'),
      width: 240,
      render: (row) => <MonoValue value={row.name} />,
    },
    {
      key: 'label',
      title: t('invocations.invocationDetail.toolRegistry.label'),
      width: 200,
      render: (row) => row.label,
    },
    {
      key: 'description',
      title: t('invocations.invocationDetail.toolRegistry.description'),
      render: (row) => (
        <p className={css({ margin: '0', whiteSpace: 'normal', overflowWrap: 'anywhere' })}>{row.description}</p>
      ),
    },
  ];
  return (
    <LazyDetails
      summary={
        <>
          {t('invocations.invocationDetail.toolRegistry.title')}
          <span className={css({ textStyle: 'small' })}>{t('invocations.invocationDetail.toolRegistry.subtitle')}</span>
        </>
      }
    >
      <TableShell columns={columns} data={registry} rowKey={(row) => row.name} />
    </LazyDetails>
  );
}

export function DetailHeader({ invocation }: { readonly invocation: InvocationDetail }): ReactElement {
  const { t } = useTranslation();
  return (
    <Panel title={t('invocations.invocationDetail.summary')}>
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '5' })}>
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
                    <AppLink to="/playground" search={{ room: invocation.chat.room_id }}>
                      {invocation.chat.room_id}
                    </AppLink>
                  ),
                },
            { label: t('invocations.invocationDetail.kv.topic'), value: String(invocation.chat.message_thread_id) },
            { label: t('invocations.invocationDetail.kv.bucket'), value: <MonoValue value={invocation.bucket_id} /> },
            { label: t('invocations.invocationDetail.kv.created'), value: <TimeText value={invocation.created_at} /> },
            { label: t('invocations.invocationDetail.kv.started'), value: <TimeText value={invocation.started_at} /> },
            {
              label: t('invocations.invocationDetail.kv.finished'),
              value: <TimeText value={invocation.finished_at} />,
            },
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
      </div>
    </Panel>
  );
}
