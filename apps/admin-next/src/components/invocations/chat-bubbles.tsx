import { ChatBubble } from '@tuuject/koi-react/chat-bubble';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { TFunction } from 'i18next';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyableValue, StateBadge, TechText, TimeText } from '@/components/business';
import { type DisclosurePart, ItemMeta } from '@/components/invocations/chat-parts';
import { isRoom, MessageRecordLink } from '@/components/invocations/shared';
import { ToolOutcomeView } from '@/components/invocations/step-details';
import { ReviewableItem } from '@/components/review/comment-note.tsx';
import type { InvocationChatSummary, InvocationDetail } from '@/lib/api/invocations.ts';
import type { ChatItem } from '@/lib/invocation-chat.ts';
import type { ParsedSendArguments } from '@/lib/timeline.ts';

type MemberItem = Extract<ChatItem, { readonly kind: 'member' }>;
type ReplyItem = Extract<ChatItem, { readonly kind: 'reply' }>;

// Koi's ChatBubble sets its own width cap; inside a flex row it must also be allowed to shrink.
const bubbleClass = css({ minWidth: '0' });
const bubbleTextClass = css({ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' });
const linkClass = css({
  color: 'text-brand',
  textUnderlineOffset: '4px',
  _hover: { textDecorationLine: 'underline' },
});
const deliveryClass = css({ display: 'inline-flex', alignItems: 'center', gap: '1' });

function messageLabel(chat: InvocationChatSummary, id: string, t: TFunction): string {
  return isRoom(chat)
    ? t('invocations.invocationDetail.send.roomMessageLabel', { id })
    : t('invocations.invocationDetail.send.messageLabel', { id });
}

/** A frozen chat message: members on the start side, the bot's own on the end side. */
export function MemberMessage({
  invocation,
  item,
}: {
  readonly invocation: InvocationDetail;
  readonly item: MemberItem;
}): ReactElement {
  const { t } = useTranslation();
  const { message } = item;
  const room = isRoom(invocation.chat);
  const align = message.fromBot ? 'end' : 'start';
  const name =
    message.senderName ??
    (message.username === null
      ? t('invocations.invocationDetail.contextMessage.unknownSender')
      : `@${message.username}`);
  return (
    <ReviewableItem
      invocation={invocation}
      event={item.event}
      position={item.position}
      align={align}
      header={
        <span className={css({ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: '2' })}>
          <span dir="auto" className={css({ textStyle: 'label' })}>
            {name}
          </span>
          {message.username !== null && name !== `@${message.username}` ? (
            <TechText className={css({ textStyle: 'small', color: 'text-muted' })}>@{message.username}</TechText>
          ) : null}
        </span>
      }
      footer={
        <ItemMeta
          align={align}
          meta={
            <>
              <TimeText value={message.sentAt} />
              {message.hostMessageId === null ? null : (
                <span>{messageLabel(invocation.chat, message.hostMessageId, t)}</span>
              )}
              <CopyableValue
                label={room ? t('invocations.invocationDetail.roomMemberRef') : t('common.telegramSenderId')}
                value={message.senderId}
              />
              <MessageRecordLink chat={invocation.chat} messageId={item.event.message.message_id} className={linkClass}>
                {t(
                  room
                    ? 'invocations.invocationDetail.contextMessage.openRoom'
                    : 'invocations.invocationDetail.contextMessage.openRecord',
                )}
              </MessageRecordLink>
            </>
          }
        />
      }
    >
      <ChatBubble side={message.fromBot ? 'sent' : 'received'} className={bubbleClass}>
        {message.text === null ? (
          <span className={message.fromBot ? undefined : css({ color: 'text-muted' })}>
            {message.kind}
            {message.mediaCount === 0
              ? ''
              : t('invocations.invocationDetail.contextMessage.mediaCount', { count: message.mediaCount })}
          </span>
        ) : (
          <span dir="auto" className={bubbleTextClass}>
            {message.text}
          </span>
        )}
      </ChatBubble>
    </ReviewableItem>
  );
}

function partText(part: ParsedSendArguments, t: TFunction): string {
  if (part.kind === 'sticker' && part.sticker_ref !== null) {
    return t('invocations.invocationDetail.send.sticker', { ref: part.sticker_ref });
  }
  const label =
    part.kind === 'image'
      ? t('invocations.invocationDetail.chat.image')
      : part.kind === 'file'
        ? t('invocations.invocationDetail.chat.file')
        : null;
  if (part.text !== null) {
    return label === null ? part.text : `${label}\n${part.text}`;
  }
  return label ?? t('invocations.invocationDetail.send.noContent');
}

/** One `send` or `send_reply` call: a bubble per message, one review anchor for the call. */
export function BotReply({
  invocation,
  item,
}: {
  readonly invocation: InvocationDetail;
  readonly item: ReplyItem;
}): ReactElement {
  const { t } = useTranslation();
  const { tool } = item.event;
  const { result } = item;
  const replyTo = item.parts[0]?.reply_to_message_id ?? null;
  const parts: DisclosurePart[] =
    result === null
      ? []
      : [
          {
            key: 'result',
            label: t('invocations.invocationDetail.toolCall.result'),
            render: () => <ToolOutcomeView result={result} />,
          },
        ];
  return (
    <ReviewableItem
      invocation={invocation}
      event={item.event}
      position={item.position}
      align="end"
      footer={
        <ItemMeta
          align="end"
          parts={parts}
          meta={
            <>
              <TimeText value={tool.created_at} />
              {replyTo === null ? null : (
                <span>
                  {t(
                    isRoom(invocation.chat)
                      ? 'invocations.invocationDetail.send.replyToRoom'
                      : 'invocations.invocationDetail.send.replyTo',
                    { id: replyTo },
                  )}
                </span>
              )}
              {item.sends.length === 0 ? (
                <span className={deliveryClass}>
                  <StateBadge state={tool.state} />
                  {tool.error_code === null ? null : <TechText>{tool.error_code}</TechText>}
                </span>
              ) : (
                item.sends.map((send) => {
                  const id = send.telegram_message_id ?? send.room_seq;
                  return (
                    <span key={send.id} className={deliveryClass}>
                      <StateBadge state={send.state} />
                      {id === null ? null : <span>{messageLabel(invocation.chat, id, t)}</span>}
                      {send.error_code === null ? null : <TechText>{send.error_code}</TechText>}
                    </span>
                  );
                })
              )}
            </>
          }
        />
      }
    >
      <div
        className={css({ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '1', minWidth: '0' })}
      >
        {item.parts.map((part, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a part's position is its identity; the arguments never reorder.
          <ChatBubble key={index} side="sent" className={bubbleClass}>
            <span dir="auto" className={bubbleTextClass}>
              {partText(part, t)}
            </span>
          </ChatBubble>
        ))}
      </div>
    </ReviewableItem>
  );
}
