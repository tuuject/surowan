import { css, cx } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { TabEmpty } from '@/components/invocations/shared';
import {
  AgentMessageCard,
  ContextMessageCard,
  ModelCallCard,
  TimelineCard,
  ToolCallCard,
} from '@/components/invocations/timeline-cards';
import type { InvocationChatSummary, InvocationDetail } from '@/lib/api/invocations.ts';
import { buildInvocationTimeline, type InvocationTimelineEvent, timelineEventKey } from '@/lib/timeline';
import { TimeText } from '@/components/business/time-text';

export function TimelineItem({
  chat,
  event,
}: {
  readonly chat: InvocationChatSummary;
  readonly event: InvocationTimelineEvent;
}): ReactElement {
  const { t } = useTranslation();
  switch (event.kind) {
    case 'queued':
      return (
        <TimelineCard
          header={
            <>
              <span className={css({ textStyle: 'label' })}>{t('invocations.invocationDetail.timeline.queued')}</span>
              <span className={css({ textStyle: 'small', color: 'text-muted' })}>
                <TimeText value={event.at} />
              </span>
            </>
          }
        />
      );
    case 'started':
      return (
        <TimelineCard
          header={
            <>
              <span className={css({ textStyle: 'label' })}>{t('invocations.invocationDetail.timeline.started')}</span>
              <span className={css({ textStyle: 'small', color: 'text-muted' })}>
                <TimeText value={event.at} />
              </span>
            </>
          }
        />
      );
    case 'finished':
      return (
        <TimelineCard
          header={
            <>
              <span className={css({ textStyle: 'label' })}>{t('invocations.invocationDetail.timeline.finished')}</span>
              <span className={css({ textStyle: 'small', color: 'text-muted' })}>
                <TimeText value={event.at} />
              </span>
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

export function OverviewTab({ invocation }: { readonly invocation: InvocationDetail }): ReactElement {
  const { t } = useTranslation();
  const events = buildInvocationTimeline(invocation);
  if (events.length === 0) {
    return <TabEmpty message={t('invocations.invocationDetail.emptyTimeline')} />;
  }
  return (
    <ol
      className={css({
        marginInlineStart: '1',
        '& > :not(:last-child)': { marginBlockEnd: '4' },
        borderInlineStartWidth: '1px',
        borderColor: 'border',
        paddingInlineStart: '6',
      })}
    >
      {events.map((event) => (
        <li key={timelineEventKey(event)} className={css({ position: 'relative' })}>
          <span
            className={cx(
              css({
                position: 'absolute',
                top: '5',
                insetInlineStart: '-29px',
                width: '10px',
                height: '10px',
                borderRadius: 'full',
              }),
              event.kind === 'finished' ? css({ bg: 'error-solid' }) : css({ bg: 'action' }),
            )}
          />
          <TimelineItem chat={invocation.chat} event={event} />
        </li>
      ))}
    </ol>
  );
}
