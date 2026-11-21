import { useQuery } from '@tanstack/react-query';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Tabs } from '@tuuject/koi-react/tabs';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { DetailError, DetailSkeleton, ListPageHeader } from '@/components/business';
import { AutoRefreshSwitch } from '@/components/invocations/auto-refresh-switch';
import { DetailHeader } from '@/components/invocations/detail-header';
import { InvocationReviewPanel } from '@/components/review/invocation-review-panel.tsx';
import { ModelCallsTab } from '@/components/invocations/model-calls-tab';
import { OverviewTab } from '@/components/invocations/overview-tab';
import { SendsTab } from '@/components/invocations/sends-tab';
import { isRoom } from '@/components/invocations/shared';
import { ToolCallsTab } from '@/components/invocations/tool-calls-tab';
import { AgentTranscriptTab, FrozenContextTab } from '@/components/invocations/transcripts-tab';
import { useCoalescedRefetch } from '@/hooks/use-coalesced-refetch';
import { useLiveRefresh } from '@/hooks/use-live-refresh';
import { ApiError } from '@/lib/api/core.ts';
import { invocationQuery } from '@/lib/queries';
import { useUiStore } from '@/stores/ui';

export function InvocationDetailView({ id }: { readonly id: string }): ReactElement {
  const { t } = useTranslation();
  const autoRefresh = useUiStore((state) => state.invocationAutoRefresh);
  const { data, isPending, error, refetch } = useQuery(invocationQuery(id));
  // Only a deleted Invocation is a final answer. A failed background refetch
  // keeps the data the reader is looking at (the QueryClient retries nothing, so
  // a deploy or a blip must not replace a live run with an error page) and keeps
  // the channel open, so the next event or poll recovers it.
  const deleted = error instanceof ApiError && error.status === 404;
  // The stream only says "something changed"; this refetch is what keeps the
  // tab, the expanded rows and the scroll position, since the query keeps its
  // data while the new one is in flight. Coalesced so a slow fetch is not
  // cancelled by the next event before it can deliver.
  useLiveRefresh({
    url: `/api/live/invocations/${encodeURIComponent(id)}`,
    enabled: autoRefresh && !deleted,
    onChange: useCoalescedRefetch(refetch),
  });

  if (isPending) {
    return <DetailSkeleton />;
  }
  if (data === undefined || deleted) {
    return (
      <DetailError
        error={error ?? new Error(t('invocations.invocationDetail.dataMissing'))}
        notFoundTitle={t('invocations.invocationDetail.notFound')}
        failedTitle={t('invocations.invocationDetail.loadFailed')}
        backTo="/invocations"
        backLabel={t('invocations.invocationDetail.backToToolSessions')}
      />
    );
  }

  return (
    <div key={data.id} className={css({ '& > * + *': { marginBlockStart: '6' } })}>
      <ListPageHeader
        title={t('invocations.invocationDetail.title', { id: data.id })}
        actions={<AutoRefreshSwitch />}
      />
      <DetailHeader invocation={data} />
      <InvocationReviewPanel invocation={data} />
      <section>
        <Tabs
          className={css({
            '& [role=tab]': { paddingInline: { base: '3', md: '4' } },
          })}
          defaultValue="overview"
          label={t('invocations.invocationDetail.tabs.overview')}
          items={[
            {
              value: 'overview',
              label: t('invocations.invocationDetail.tabs.overview'),
              content: <OverviewTab invocation={data} />,
            },
            {
              value: 'tools',
              label: t('invocations.invocationDetail.tabs.toolCalls', { count: data.tool_calls.length }),
              content: <ToolCallsTab invocation={data} />,
            },
            {
              value: 'models',
              label: t('invocations.invocationDetail.tabs.modelCalls', { count: data.model_calls.length }),
              content: <ModelCallsTab invocation={data} />,
            },
            {
              value: 'sends',
              label: t(
                isRoom(data.chat)
                  ? 'invocations.invocationDetail.tabs.roomSends'
                  : 'invocations.invocationDetail.tabs.telegramSends',
                { count: data.telegram_sends.length },
              ),
              content: <SendsTab invocation={data} />,
            },
            {
              value: 'agent',
              label: t('invocations.invocationDetail.tabs.agentTranscript', {
                count: data.agent_messages.length,
              }),
              content: <AgentTranscriptTab invocation={data} />,
            },
            {
              value: 'context',
              label: t('invocations.invocationDetail.tabs.frozenContext', {
                count: data.context_messages.length,
              }),
              content: <FrozenContextTab invocation={data} />,
            },
          ]}
        />
      </section>
    </div>
  );
}
