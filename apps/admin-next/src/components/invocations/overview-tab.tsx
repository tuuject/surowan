import type React from 'react';
import { useTranslation } from 'react-i18next';
import { TabEmpty } from '@/components/invocations/shared';
import {
  AgentMessageCard,
  ContextMessageCard,
  ModelCallCard,
  TimelineCard,
  ToolCallCard,
} from '@/components/invocations/timeline-cards';

import { formatTime } from '@/lib/format';
import { buildInvocationTimeline, type InvocationTimelineEvent, timelineEventKey } from '@/lib/timeline';
import { cn } from '@/lib/utils';
import type { InvocationChatSummary, InvocationDetail } from '@/lib/api/invocations.ts';

export function TimelineItem({
  chat,
  event,
}: {
  readonly chat: InvocationChatSummary;
  readonly event: InvocationTimelineEvent;
}): React.ReactElement {
  const { t } = useTranslation();
  switch (event.kind) {
    case 'queued':
      return (
        <TimelineCard
          header={
            <>
              <span className="text-sm font-medium">{t('invocations.invocationDetail.timeline.queued')}</span>
              <span className="text-muted-foreground text-xs">{formatTime(event.at)}</span>
            </>
          }
        />
      );
    case 'started':
      return (
        <TimelineCard
          header={
            <>
              <span className="text-sm font-medium">{t('invocations.invocationDetail.timeline.started')}</span>
              <span className="text-muted-foreground text-xs">{formatTime(event.at)}</span>
            </>
          }
        />
      );
    case 'finished':
      return (
        <TimelineCard
          header={
            <>
              <span className="text-sm font-medium">{t('invocations.invocationDetail.timeline.finished')}</span>
              <span className="text-muted-foreground text-xs">{formatTime(event.at)}</span>
            </>
          }
        />
      );
    case 'context_message':
      return <ContextMessageCard chat={chat} message={event.message} />;
    case 'model_call':
      return <ModelCallCard model={event.model} />;
    case 'tool_call':
      return <ToolCallCard chat={chat} tool={event.tool} send={event.linkedSend} />;
    case 'agent_message':
      return <AgentMessageCard message={event.message} />;
  }
}

export function OverviewTab({ invocation }: { readonly invocation: InvocationDetail }): React.ReactElement {
  const { t } = useTranslation();
  const events = buildInvocationTimeline(invocation);
  if (events.length === 0) {
    return <TabEmpty message={t('invocations.invocationDetail.emptyTimeline')} />;
  }
  return (
    <ol className="ml-1 space-y-4 border-l border-border pl-6">
      {events.map((event) => (
        <li key={timelineEventKey(event)} className="relative">
          <span
            className={cn(
              'absolute top-5 -left-[29px] size-2.5 rounded-full',
              event.kind === 'finished' ? 'bg-destructive' : 'bg-primary',
            )}
          />
          <TimelineItem chat={invocation.chat} event={event} />
        </li>
      ))}
    </ol>
  );
}
