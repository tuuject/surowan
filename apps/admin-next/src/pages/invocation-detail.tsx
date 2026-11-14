import { useQuery } from '@tanstack/react-query';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Tabs } from '@tuuject/koi-react/tabs';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { DetailError, DetailSkeleton, ListPageHeader } from '@/components/business';
import { DetailHeader } from '@/components/invocations/detail-header';
import { InvocationReviewPanel } from '@/components/review/invocation-review-panel.tsx';
import { ModelCallsTab } from '@/components/invocations/model-calls-tab';
import { OverviewTab } from '@/components/invocations/overview-tab';
import { SendsTab } from '@/components/invocations/sends-tab';
import { isRoom } from '@/components/invocations/shared';
import { ToolCallsTab } from '@/components/invocations/tool-calls-tab';
import { AgentTranscriptTab, FrozenContextTab } from '@/components/invocations/transcripts-tab';
import { invocationQuery } from '@/lib/queries';

export function InvocationDetailView({ id }: { readonly id: string }): ReactElement {
  const { t } = useTranslation();
  const { data, isPending, isError, error } = useQuery(invocationQuery(id));

  if (isPending) {
    return <DetailSkeleton />;
  }
  if (isError) {
    return (
      <DetailError
        error={error}
        notFoundTitle={t('invocations.invocationDetail.notFound')}
        failedTitle={t('invocations.invocationDetail.loadFailed')}
        backTo="/invocations"
        backLabel={t('invocations.invocationDetail.backToToolSessions')}
      />
    );
  }
  if (data === undefined) {
    return (
      <DetailError
        error={new Error(t('invocations.invocationDetail.dataMissing'))}
        notFoundTitle={t('invocations.invocationDetail.notFound')}
        failedTitle={t('invocations.invocationDetail.loadFailed')}
        backTo="/invocations"
        backLabel={t('invocations.invocationDetail.backToToolSessions')}
      />
    );
  }

  return (
    <div key={data.id} className={css({ '& > * + *': { marginBlockStart: '6' } })}>
      <ListPageHeader title={t('invocations.invocationDetail.title', { id: data.id })} />
      <DetailHeader invocation={data} />
      <InvocationReviewPanel invocation={data} />
      <section>
        <Tabs
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
