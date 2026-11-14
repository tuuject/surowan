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
import { EventReviewAffordance } from '@/components/review/comment-note.tsx';
import type { InvocationDetail } from '@/lib/api/invocations.ts';
import { buildInvocationTimeline, type InvocationTimelineEvent, timelineEventKey } from '@/lib/timeline';
import { TimeText } from '@/components/business/time-text';

export function TimelineItem({
  invocation,
  event,
  position,
}: {
  readonly invocation: InvocationDetail;
  readonly event: InvocationTimelineEvent;
  readonly position: number;
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
      return (
        <ContextMessageCard
          chat={invocation.chat}
          message={event.message}
          footer={<EventReviewAffordance invocation={invocation} event={event} position={position} />}
        />
      );
    case 'model_call':
      return (
        <ModelCallCard
          model={event.model}
          footer={<EventReviewAffordance invocation={invocation} event={event} position={position} />}
        />
      );
    case 'tool_call':
      return (
        <ToolCallCard
          chat={invocation.chat}
          tool={event.tool}
          send={event.linkedSend}
          footer={<EventReviewAffordance invocation={invocation} event={event} position={position} />}
        />
      );
    case 'agent_message':
      return (
        <AgentMessageCard
          message={event.message}
          footer={<EventReviewAffordance invocation={invocation} event={event} position={position} />}
        />
      );
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
      {events.map((event, index) => (
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
          <TimelineItem invocation={invocation} event={event} position={index} />
        </li>
      ))}
    </ol>
  );
}
