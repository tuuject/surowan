import { useQuery } from '@tanstack/react-query';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { DetailError, DetailSkeleton } from '@/components/business';
import { DetailHeader } from '@/components/invocations/detail-header';
import { ModelCallsTab } from '@/components/invocations/model-calls-tab';
import { OverviewTab } from '@/components/invocations/overview-tab';
import { SendsTab } from '@/components/invocations/sends-tab';
import { isRoom } from '@/components/invocations/shared';
import { ToolCallsTab } from '@/components/invocations/tool-calls-tab';
import { AgentTranscriptTab, FrozenContextTab } from '@/components/invocations/transcripts-tab';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { invocationQuery } from '@/lib/queries';

export function InvocationDetailView({ id }: { readonly id: string }): React.ReactElement {
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
    <div className="space-y-4">
      <DetailHeader invocation={data} />
      <Card className="gap-0 py-4">
        <CardContent className="px-0 py-0">
          <Tabs defaultValue="overview">
            <TabsList className="mx-4 flex-wrap">
              <TabsTrigger value="overview">{t('invocations.invocationDetail.tabs.overview')}</TabsTrigger>
              <TabsTrigger value="tools">
                {t('invocations.invocationDetail.tabs.toolCalls', { count: data.tool_calls.length })}
              </TabsTrigger>
              <TabsTrigger value="models">
                {t('invocations.invocationDetail.tabs.modelCalls', { count: data.model_calls.length })}
              </TabsTrigger>
              <TabsTrigger value="sends">
                {t(
                  isRoom(data.chat)
                    ? 'invocations.invocationDetail.tabs.roomSends'
                    : 'invocations.invocationDetail.tabs.telegramSends',
                  { count: data.telegram_sends.length },
                )}
              </TabsTrigger>
              <TabsTrigger value="agent">
                {t('invocations.invocationDetail.tabs.agentTranscript', { count: data.agent_messages.length })}
              </TabsTrigger>
              <TabsTrigger value="context">
                {t('invocations.invocationDetail.tabs.frozenContext', { count: data.context_messages.length })}
              </TabsTrigger>
            </TabsList>
            <div className="p-4 md:p-6">
              <TabsContent value="overview">
                <OverviewTab invocation={data} />
              </TabsContent>
              <TabsContent value="tools">
                <ToolCallsTab invocation={data} />
              </TabsContent>
              <TabsContent value="models">
                <ModelCallsTab invocation={data} />
              </TabsContent>
              <TabsContent value="sends">
                <SendsTab invocation={data} />
              </TabsContent>
              <TabsContent value="agent">
                <AgentTranscriptTab invocation={data} />
              </TabsContent>
              <TabsContent value="context">
                <FrozenContextTab invocation={data} />
              </TabsContent>
            </div>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
