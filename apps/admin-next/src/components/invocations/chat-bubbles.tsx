import { ChatBubble } from '@tuuject/koi-react/chat-bubble';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { TFunction } from 'i18next';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyableValue, StateBadge, TechText, TimeText } from '@/components/business';
import { isRoom, MessageRecordLink } from '@/components/invocations/shared';
import { ToolOutcomeDetails } from '@/components/invocations/step-details';
import { ReviewableItem } from '@/components/review/comment-note.tsx';
import type { InvocationDetail } from '@/lib/api/invocations.ts';
import type { ChatItem } from '@/lib/invocation-chat.ts';
import type { ParsedSendArguments } from '@/lib/timeline.ts';

type MemberItem = Extract<ChatItem, { readonly kind: 'member' }>;
type ReplyItem = Extract<ChatItem, { readonly kind: 'reply' }>;

const bubbleClass = css({ maxWidth: '560px', minWidth: '0' });
const bubbleTextClass = css({ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' });
const metaClass = css({
  textStyle: 'small',
  color: 'text-muted',
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  columnGap: '3',
  rowGap: '1',
});
const linkClass = css({
  color: 'text-brand',
  textUnderlineOffset: '4px',
  _hover: { textDecorationLine: 'underline' },
});

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
      align={message.fromBot ? 'end' : 'start'}
      header={
        <div className={metaClass}>
          <span dir="auto" className={css({ textStyle: 'label', color: 'text' })}>
            {name}
          </span>
          {message.username !== null && name !== `@${message.username}` ? (
            <TechText>@{message.username}</TechText>
          ) : null}
          <TimeText value={message.sentAt} />
        </div>
      }
      footer={
        <div className={metaClass}>
          <CopyableValue
            label={room ? t('invocations.invocationDetail.roomMemberRef') : t('common.telegramSenderId')}
            value={message.senderId}
          />
          {message.hostMessageId === null ? null : (
            <span>
              {t(
                room
                  ? 'invocations.invocationDetail.contextMessage.roomMessage'
                  : 'invocations.invocationDetail.contextMessage.telegramMessage',
                { id: message.hostMessageId, kind: message.kind },
              )}
            </span>
          )}
          <MessageRecordLink chat={invocation.chat} messageId={item.event.message.message_id} className={linkClass}>
            {t(
              room
                ? 'invocations.invocationDetail.contextMessage.openRoom'
                : 'invocations.invocationDetail.contextMessage.openRecord',
            )}
          </MessageRecordLink>
        </div>
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
  const room = isRoom(invocation.chat);
  const replyTo = item.parts[0]?.reply_to_message_id ?? null;
  return (
    <ReviewableItem
      invocation={invocation}
      event={item.event}
      position={item.position}
      align="end"
      footer={
        <>
          <div className={metaClass}>
            {replyTo === null ? null : (
              <span>
                {t(
                  room ? 'invocations.invocationDetail.send.replyToRoom' : 'invocations.invocationDetail.send.replyTo',
                  {
                    id: replyTo,
                  },
                )}
              </span>
            )}
            {item.sends.length === 0 ? (
              <span className={css({ display: 'inline-flex', alignItems: 'center', gap: '1' })}>
                <StateBadge state={tool.state} />
                {tool.error_code === null ? null : <TechText>{tool.error_code}</TechText>}
              </span>
            ) : (
              item.sends.map((send) => (
                <span key={send.id} className={css({ display: 'inline-flex', alignItems: 'center', gap: '1' })}>
                  <StateBadge state={send.state} />
                  {send.telegram_message_id !== null ? (
                    <span>{t('invocations.invocationDetail.send.messageLabel', { id: send.telegram_message_id })}</span>
                  ) : send.room_seq !== null ? (
                    <span>{t('invocations.invocationDetail.send.roomMessageLabel', { id: send.room_seq })}</span>
                  ) : null}
                  {send.error_code === null ? null : <TechText>{send.error_code}</TechText>}
                </span>
              ))
            )}
            <TimeText value={tool.created_at} />
          </div>
          {item.result === null ? null : <ToolOutcomeDetails result={item.result} />}
        </>
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
