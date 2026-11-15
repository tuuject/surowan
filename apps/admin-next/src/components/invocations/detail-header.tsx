import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '@tuuject/koi-react/button';
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
import { PlayIcon } from '@/components/icons';
import { Panel } from '@/components/layout/panel';
import { AppLink } from '@/components/router-links';
import { type InvocationDetail, resumeInvocation, type ToolRegistryEntry } from '@/lib/api/invocations.ts';
import { errorMessage } from '@/lib/errors';
import { formatCost, formatNumber } from '@/lib/format';
import { toast } from '@/lib/toast.ts';

/**
 * One click queues a real run that continues this failed invocation with the
 * current configuration. The server offers it only for the latest run of its
 * conversation, so the button appears exactly when the click would be accepted.
 */
function ResumeButton({ invocationId }: { readonly invocationId: string }): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const resume = useMutation({
    mutationFn: () => resumeInvocation(invocationId),
    onSuccess: (result) => {
      toast.success(t('invocations.invocationDetail.resume.queued', { id: result.invocation_id }));
      void navigate({ to: '/invocations/$invocationId', params: { invocationId: result.invocation_id } });
    },
    onError: (error) => toast.error(errorMessage(error)),
    // A refusal usually means the page is stale (another operator resumed it,
    // or the chat changed); refetching hides a button that can no longer work.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['invocation', invocationId] });
      void queryClient.invalidateQueries({ queryKey: ['invocations'] });
    },
  });
  return (
    <Button
      type="button"
      size="sm"
      title={t('invocations.invocationDetail.resume.hint')}
      disabled={resume.isPending}
      onClick={() => resume.mutate()}
    >
      <PlayIcon size={14} />
      {t('invocations.invocationDetail.resume.action')}
    </Button>
  );
}

function InvocationLink({ id }: { readonly id: string }): ReactElement {
  return (
    <AppLink to="/invocations/$invocationId" params={{ invocationId: id }}>
      {id}
    </AppLink>
  );
}

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
    <Panel
      title={t('invocations.invocationDetail.summary')}
      {...(invocation.resume.available ? { action: <ResumeButton invocationId={invocation.id} /> } : {})}
    >
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '5' })}>
        <KvList
          items={[
            { label: t('invocations.invocationDetail.kv.state'), value: <StateBadge state={invocation.state} /> },
            ...(invocation.resumed_from_invocation_id === null
              ? []
              : [
                  {
                    label: t('invocations.invocationDetail.kv.resumedFrom'),
                    value: <InvocationLink id={invocation.resumed_from_invocation_id} />,
                  },
                ]),
            ...(invocation.resumed_by_invocation_id === null
              ? []
              : [
                  {
                    label: t('invocations.invocationDetail.kv.resumedBy'),
                    value: <InvocationLink id={invocation.resumed_by_invocation_id} />,
                  },
                ]),
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
