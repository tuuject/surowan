import { css } from '@tuuject/koi-react/styled-system/css';
import type React from 'react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CopyableValue,
  JsonViewer,
  LazyDetails,
  PrivateReasoningTag,
  StateBadge,
  ToneBadge,
} from '@/components/business';
import { isRoom, MessageRecordLink, RoleBadge, SectionBadge } from '@/components/invocations/shared';
import type { ContextMessageEntry } from '@/lib/api/contexts.ts';
import type {
  AgentMessageEntry,
  InvocationChatSummary,
  ModelCallEntry,
  TelegramSendEntry,
  ToolCallEntry,
} from '@/lib/api/invocations.ts';
import { formatCost, formatDuration, formatNumber, formatTime } from '@/lib/format';
import {
  objectField,
  type ParsedSendArguments,
  parseJsonObject,
  parseSendArguments,
  stringField,
} from '@/lib/timeline';
import { ToolResult } from './tool-result';

export function TimelineCard({
  header,
  extra,
  children,
}: {
  readonly header: React.ReactNode;
  readonly extra?: string;
  readonly children?: React.ReactNode;
}): ReactElement {
  return (
    <article
      className={css({
        '& > :not(:last-child)': { marginBlockEnd: '2' },
        borderTopWidth: '1px',
        borderColor: 'divider',
        paddingBlock: '3',
      })}
    >
      <div
        className={css({
          display: 'flex',
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '2',
        })}
      >
        <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>{header}</div>
        {extra !== undefined ? <span className={css({ textStyle: 'small', color: 'text-muted' })}>{extra}</span> : null}
      </div>
      {children !== undefined ? (
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>{children}</div>
      ) : null}
    </article>
  );
}

function SendContent({
  chat,
  parsed,
  send,
}: {
  readonly chat: InvocationChatSummary;
  readonly parsed: ParsedSendArguments;
  readonly send: TelegramSendEntry | null;
}): ReactElement {
  const { t } = useTranslation();
  const room = isRoom(chat);
  const content =
    parsed.kind === 'text'
      ? parsed.text
      : parsed.kind === 'sticker' && parsed.sticker_ref !== null
        ? t('invocations.invocationDetail.send.sticker', { ref: parsed.sticker_ref })
        : null;
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
      {content === null ? (
        <p className={css({ textStyle: 'body', color: 'text-muted' })}>
          {t('invocations.invocationDetail.send.noContent')}
        </p>
      ) : (
        <p className={css({ textStyle: 'body', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' })}>{content}</p>
      )}
      <div
        className={css({
          textStyle: 'small',
          color: 'text-muted',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '3',
        })}
      >
        {parsed.reply_to_message_id !== null ? (
          <span>
            {t(room ? 'invocations.invocationDetail.send.replyToRoom' : 'invocations.invocationDetail.send.replyTo', {
              id: parsed.reply_to_message_id,
            })}
          </span>
        ) : null}
        {send !== null ? (
          <>
            <span>{t('invocations.invocationDetail.send.delivery')}</span>
            <StateBadge state={send.state} />
            {send.telegram_message_id !== null ? (
              <span>{t('invocations.invocationDetail.send.messageLabel', { id: send.telegram_message_id })}</span>
            ) : null}
            {send.room_seq !== null ? (
              <span>{t('invocations.invocationDetail.send.roomMessageLabel', { id: send.room_seq })}</span>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

export function ToolCallCard({
  chat,
  tool,
  send,
}: {
  readonly chat: InvocationChatSummary;
  readonly tool: ToolCallEntry;
  readonly send: TelegramSendEntry | null;
}): ReactElement {
  const { t } = useTranslation();
  const parsed = parseSendArguments(tool.arguments_json);
  return (
    <TimelineCard
      header={
        <>
          <ToneBadge tone={tool.tool_name === 'send' ? 'success' : 'neutral'}>{tool.tool_name}</ToneBadge>
          <code
            className={css({
              textStyle: 'small',
              borderRadius: 'lg',
              bg: 'surface-muted',
              paddingInline: '1',
              paddingBlock: '1',
              fontFamily: 'mono',
            })}
          >
            {tool.tool_call_id}
          </code>
          <StateBadge state={tool.state} />
        </>
      }
      extra={formatTime(tool.created_at)}
    >
      {tool.tool_name === 'send' ? <SendContent chat={chat} parsed={parsed} send={send} /> : null}
      <div
        className={css({
          textStyle: 'small',
          color: 'text-muted',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '3',
        })}
      >
        <span>{t('invocations.invocationDetail.toolCall.duration', { value: formatDuration(tool.duration_ms) })}</span>
        {tool.error_code !== null ? (
          <span className={css({ color: 'error-text' })}>
            {t('invocations.invocationDetail.toolCall.error', { code: tool.error_code })}
          </span>
        ) : null}
      </div>
      <LazyDetails summary={t('invocations.invocationDetail.toolCall.argumentsAndResult')}>
        <JsonViewer value={tool.arguments_json} title={t('invocations.invocationDetail.toolCall.arguments')} />
        {tool.result_content ? (
          <ToolResult content={tool.result_content} />
        ) : (
          <JsonViewer value={tool.result_text} title={t('invocations.invocationDetail.toolCall.result')} />
        )}
      </LazyDetails>
    </TimelineCard>
  );
}

export function ContextMessageCard({
  chat,
  message,
}: {
  readonly chat: InvocationChatSummary;
  readonly message: ContextMessageEntry;
}): ReactElement {
  const { t } = useTranslation();
  const room = isRoom(chat);
  const snapshot = parseJsonObject(message.snapshot_json);
  const sender = objectField(snapshot, 'sender');
  const username = stringField(sender, 'username');
  const senderName =
    stringField(sender, 'name') ??
    (username === null ? t('invocations.invocationDetail.contextMessage.unknownSender') : `@${username}`);
  // A room snapshot's message_id is the room's own sequence.
  const hostMessageId = stringField(snapshot, 'message_id');
  const kind = stringField(snapshot, 'kind') ?? 'message';
  const text = stringField(snapshot, 'text') ?? stringField(snapshot, 'caption');
  const media = snapshot?.media;
  const mediaCount = Array.isArray(media) ? media.length : 0;
  const sentByBot = snapshot?.sent_by_bot === true;
  return (
    <TimelineCard
      header={
        <>
          <SectionBadge section={message.section} />
          <span className={css({ textStyle: 'label' })}>{senderName}</span>
          {username !== null && senderName !== `@${username}` ? (
            <span className={css({ textStyle: 'small', color: 'text-muted' })}>@{username}</span>
          ) : null}
          {sentByBot ? <span className={css({ textStyle: 'small', color: 'text-muted' })}>bot</span> : null}
          {room ? (
            <CopyableValue label={t('invocations.invocationDetail.roomMemberRef')} value={stringField(sender, 'ref')} />
          ) : (
            <CopyableValue label={t('common.telegramSenderId')} value={stringField(sender, 'id')} />
          )}
        </>
      }
      extra={formatTime(stringField(snapshot, room ? 'sent_at' : 'telegram_date'))}
    >
      {text === null ? (
        <p className={css({ textStyle: 'body', color: 'text-muted' })}>
          {kind}
          {mediaCount === 0 ? '' : t('invocations.invocationDetail.contextMessage.mediaCount', { count: mediaCount })}
        </p>
      ) : (
        <p className={css({ textStyle: 'body', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' })}>{text}</p>
      )}
      <div
        className={css({
          textStyle: 'small',
          color: 'text-muted',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '2',
        })}
      >
        <span>
          {hostMessageId === null
            ? kind
            : t(
                room
                  ? 'invocations.invocationDetail.contextMessage.roomMessage'
                  : 'invocations.invocationDetail.contextMessage.telegramMessage',
                { id: hostMessageId, kind },
              )}
        </span>
        <MessageRecordLink
          chat={chat}
          messageId={message.message_id}
          className={css({
            color: 'text-brand',
            textUnderlineOffset: '4px',
            _hover: { textDecorationLine: 'underline' },
          })}
        >
          {t(
            room
              ? 'invocations.invocationDetail.contextMessage.openRoom'
              : 'invocations.invocationDetail.contextMessage.openRecord',
          )}
        </MessageRecordLink>
      </div>
    </TimelineCard>
  );
}

export function AgentMessageCard({ message }: { readonly message: AgentMessageEntry }): ReactElement {
  const { t } = useTranslation();
  const AGENT_ROLE_LABELS: Record<string, { readonly label: string; readonly note: string | null }> = {
    assistant: {
      label: t('invocations.invocationDetail.agentRoles.assistantLabel'),
      note: t('invocations.invocationDetail.agentRoles.assistantNote'),
    },
    tool_result: { label: t('invocations.invocationDetail.agentRoles.toolResultLabel'), note: null },
    harness_nudge: {
      label: t('invocations.invocationDetail.agentRoles.harnessNudgeLabel'),
      note: t('invocations.invocationDetail.agentRoles.harnessNudgeNote'),
    },
  };
  const meta = AGENT_ROLE_LABELS[message.role] ?? { label: message.role, note: null };
  return (
    <TimelineCard
      header={
        <>
          <RoleBadge role={message.role} />
          <span className={css({ textStyle: 'body' })}>{meta.label}</span>
          {meta.note !== null ? (
            <span className={css({ textStyle: 'small', color: 'text-muted' })}>{meta.note}</span>
          ) : null}
          {message.role === 'assistant' ? <PrivateReasoningTag /> : null}
        </>
      }
      extra={formatTime(message.created_at)}
    >
      {message.result_content ? (
        <ToolResult content={message.result_content} />
      ) : message.role === 'assistant' && message.thinking_text.length > 0 ? (
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
          <LazyDetails summary={t('invocations.invocationDetail.agent.thinkingLabel')}>
            {message.thinking_text}
          </LazyDetails>
          {message.text.length === 0 ? (
            <p className={css({ textStyle: 'body', color: 'text-muted' })}>
              {t('invocations.invocationDetail.agent.noText')}
            </p>
          ) : (
            <p className={css({ textStyle: 'body', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' })}>
              {message.text}
            </p>
          )}
        </div>
      ) : message.text.length === 0 ? (
        <p className={css({ textStyle: 'body', color: 'text-muted' })}>
          {t('invocations.invocationDetail.agent.noText')}
        </p>
      ) : message.role === 'tool_result' ? (
        <LazyDetails summary={t('invocations.invocationDetail.agent.viewToolResult')}>{message.text}</LazyDetails>
      ) : (
        <p className={css({ textStyle: 'body', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' })}>{message.text}</p>
      )}
    </TimelineCard>
  );
}

export function ModelCallCard({ model }: { readonly model: ModelCallEntry }): ReactElement {
  const { t } = useTranslation();
  const hasDetails = model.error_detail !== null || model.request_json !== null || model.response_json !== null;
  return (
    <TimelineCard
      header={
        <>
          <ToneBadge tone="info">{t('invocations.invocationDetail.modelCall.badge')}</ToneBadge>
          <span className={css({ textStyle: 'label' })}>
            {model.provider}/{model.model}
          </span>
          <StateBadge state={model.state} />
        </>
      }
      extra={formatTime(model.created_at)}
    >
      <div
        className={css({
          textStyle: 'small',
          color: 'text-muted',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '3',
        })}
      >
        <span>{t('invocations.invocationDetail.modelCall.attempt', { value: model.attempt })}</span>
        <span>{t('invocations.invocationDetail.modelCall.tokens', { value: formatNumber(model.total_tokens) })}</span>
        <span>
          {t('invocations.invocationDetail.modelCall.cacheRead', { value: formatNumber(model.cache_read_tokens) })}
        </span>
        <span>
          {t('invocations.invocationDetail.modelCall.cacheWrite', { value: formatNumber(model.cache_write_tokens) })}
        </span>
        <span>{t('invocations.invocationDetail.modelCall.cost', { value: formatCost(model.cost) })}</span>
        <span>
          {t('invocations.invocationDetail.modelCall.duration', { value: formatDuration(model.duration_ms) })}
        </span>
        {model.error_code !== null ? (
          <span className={css({ color: 'error-text' })}>
            {t('invocations.invocationDetail.modelCall.error', { code: model.error_code })}
          </span>
        ) : null}
      </div>
      {hasDetails ? (
        <LazyDetails summary={t('invocations.invocationDetail.modelCall.viewDetails')}>
          {model.error_detail !== null ? (
            <div>
              <p className={css({ textStyle: 'small', color: 'text-muted' })}>
                {t('invocations.invocationDetail.modelCall.fullErrorDetails')}
              </p>
              <pre
                className={css({
                  textStyle: 'small',
                  color: 'error-text',
                  marginBlockStart: '1',
                  maxHeight: '240px',
                  overflow: 'auto',
                  borderRadius: 'lg',
                  borderWidth: '1px',
                  borderColor: 'border',
                  bg: 'surface-muted',
                  padding: '2',
                  overflowWrap: 'anywhere',
                  whiteSpace: 'pre-wrap',
                })}
              >
                {model.error_detail}
              </pre>
            </div>
          ) : null}
          {model.request_json !== null ? (
            <JsonViewer
              value={model.request_json}
              initiallyCollapsed
              title={t('invocations.invocationDetail.modelCall.requestPayload')}
              downloadFileName={`model-call-${model.id}-request.json`}
            />
          ) : null}
          {model.response_json !== null ? (
            <JsonViewer
              value={model.response_json}
              initiallyCollapsed
              title={t('invocations.invocationDetail.modelCall.responseStatus')}
            />
          ) : null}
        </LazyDetails>
      ) : null}
      {model.request_json === null && model.response_json === null ? (
        <p className={css({ textStyle: 'small', color: 'text-muted' })}>
          {t('invocations.invocationDetail.modelCall.rawUnavailable')}
        </p>
      ) : null}
    </TimelineCard>
  );
}
