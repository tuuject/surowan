import { Divider } from '@tuuject/koi-react/divider';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { TimeText } from '@/components/business';
import { BotReply, MemberMessage } from '@/components/invocations/chat-bubbles';
import { ChatDisclosure, StepGroup } from '@/components/invocations/chat-steps';
import { TabEmpty } from '@/components/invocations/shared';
import type { InvocationDetail } from '@/lib/api/invocations.ts';
import { buildInvocationChat, type ChatBatch, type ChatItem } from '@/lib/invocation-chat.ts';
import { timelineEventKey } from '@/lib/timeline';
import { useReviewStore } from '@/stores/review.ts';

const columnClass = css({ display: 'flex', flexDirection: 'column', gap: '4', minWidth: '0' });

function ChatItemView({
  invocation,
  item,
}: {
  readonly invocation: InvocationDetail;
  readonly item: ChatItem;
}): ReactElement | null {
  switch (item.kind) {
    case 'member':
      return <MemberMessage invocation={invocation} item={item} />;
    case 'reply':
      return <BotReply invocation={invocation} item={item} />;
    case 'steps':
      return <StepGroup invocation={invocation} item={item} />;
  }
}

function chatItemKey(item: ChatItem): string {
  return item.kind === 'steps' ? item.key : timelineEventKey(item.event);
}

function TimedDivider({ label, at }: { readonly label: ReactNode; readonly at: string | null }): ReactElement {
  return (
    <Divider
      label={
        <span className={css({ display: 'inline-flex', flexWrap: 'wrap', justifyContent: 'center', columnGap: '2' })}>
          <span>{label}</span>
          <TimeText value={at} />
        </span>
      }
    />
  );
}

function batchLabelKey(batch: ChatBatch) {
  switch (batch.status) {
    case 'injected':
      return 'invocations.invocationDetail.chat.batch';
    case 'pending':
      return 'invocations.invocationDetail.chat.batchPending';
    case 'skipped':
      return 'invocations.invocationDetail.chat.batchSkipped';
  }
}

/**
 * The run read as a chat: retained history (collapsed), then each batch with
 * its messages, the steps the model took and the replies it sent.
 */
export function OverviewTab({ invocation }: { readonly invocation: InvocationDetail }): ReactElement {
  const { t } = useTranslation();
  const comments = useReviewStore((state) => state.invocations[invocation.id]?.comments);
  const chat = buildInvocationChat(invocation);
  if (chat.history.length === 0 && chat.batches.every((batch) => batch.items.length === 0)) {
    return <TabEmpty message={t('invocations.invocationDetail.emptyTimeline')} />;
  }
  const historyCommented = chat.history.some(
    (item) => item.kind !== 'steps' && comments?.[timelineEventKey(item.event)] !== undefined,
  );
  return (
    <div className={css({ maxWidth: '960px' })}>
      <div className={columnClass}>
        {chat.history.length === 0 ? null : (
          <ChatDisclosure
            summary={t('invocations.invocationDetail.chat.history', { count: chat.history.length })}
            defaultOpen={historyCommented}
          >
            <div className={columnClass}>
              {chat.history.map((item) => (
                <ChatItemView key={chatItemKey(item)} invocation={invocation} item={item} />
              ))}
            </div>
          </ChatDisclosure>
        )}
        {chat.batches.map((batch) => (
          <div key={batch.bucketId} className={columnClass}>
            <TimedDivider label={t(batchLabelKey(batch))} at={batch.at} />
            {batch.items.map((item) => (
              <ChatItemView key={chatItemKey(item)} invocation={invocation} item={item} />
            ))}
          </div>
        ))}
        {invocation.finished_at === null ? null : (
          <TimedDivider label={t('invocations.invocationDetail.chat.finished')} at={invocation.finished_at} />
        )}
      </div>
    </div>
  );
}
