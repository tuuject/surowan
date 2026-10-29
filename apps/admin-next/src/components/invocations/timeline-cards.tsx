import type React from 'react';
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
import { Card, CardContent, CardHeader } from '@/components/ui/card';

import { formatCost, formatDuration, formatNumber, formatTime } from '@/lib/format';
import {
  objectField,
  type ParsedSendArguments,
  parseJsonObject,
  parseSendArguments,
  stringField,
} from '@/lib/timeline';
import type {
  AgentMessageEntry,
  InvocationChatSummary,
  ModelCallEntry,
  TelegramSendEntry,
  ToolCallEntry,
} from '@/lib/api/invocations.ts';
import type { ContextMessageEntry } from '@/lib/api/contexts.ts';

export function TimelineCard({
  header,
  extra,
  children,
}: {
  readonly header: React.ReactNode;
  readonly extra?: string;
  readonly children?: React.ReactNode;
}): React.ReactElement {
  return (
    <Card className="gap-2 py-3">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 px-3 py-0">
        <div className="flex flex-wrap items-center gap-1.5">{header}</div>
        {extra !== undefined ? <span className="text-muted-foreground text-xs">{extra}</span> : null}
      </CardHeader>
      {children !== undefined ? <CardContent className="space-y-2 px-3 py-0">{children}</CardContent> : null}
    </Card>
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
}): React.ReactElement {
  const { t } = useTranslation();
  const room = isRoom(chat);
  const content =
    parsed.kind === 'text'
      ? parsed.text
      : parsed.kind === 'sticker' && parsed.sticker_ref !== null
        ? t('invocations.invocationDetail.send.sticker', { ref: parsed.sticker_ref })
        : null;
  return (
    <div className="space-y-1.5">
      {content === null ? (
        <p className="text-muted-foreground text-sm">{t('invocations.invocationDetail.send.noContent')}</p>
      ) : (
        <p className="text-sm break-words whitespace-pre-wrap">{content}</p>
      )}
      <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
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
}): React.ReactElement {
  const { t } = useTranslation();
  const parsed = parseSendArguments(tool.arguments_json);
  return (
    <TimelineCard
      header={
        <>
          <ToneBadge tone={tool.tool_name === 'send' ? 'success' : 'neutral'}>{tool.tool_name}</ToneBadge>
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{tool.tool_call_id}</code>
          <StateBadge state={tool.state} />
        </>
      }
      extra={formatTime(tool.created_at)}
    >
      {tool.tool_name === 'send' ? <SendContent chat={chat} parsed={parsed} send={send} /> : null}
      <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
        <span>{t('invocations.invocationDetail.toolCall.duration', { value: formatDuration(tool.duration_ms) })}</span>
        {tool.error_code !== null ? (
          <span className="text-destructive">
            {t('invocations.invocationDetail.toolCall.error', { code: tool.error_code })}
          </span>
        ) : null}
      </div>
      <LazyDetails
        summary={t('invocations.invocationDetail.toolCall.argumentsAndResult')}
        summaryClassName="text-muted-foreground cursor-pointer text-xs"
        contentClassName="mt-2 space-y-2"
      >
        <JsonViewer value={tool.arguments_json} title={t('invocations.invocationDetail.toolCall.arguments')} />
        <JsonViewer value={tool.result_text} title={t('invocations.invocationDetail.toolCall.result')} />
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
}): React.ReactElement {
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
          <span className="text-sm font-medium">{senderName}</span>
          {username !== null && senderName !== `@${username}` ? (
            <span className="text-muted-foreground text-xs">@{username}</span>
          ) : null}
          {sentByBot ? <span className="text-muted-foreground text-xs">bot</span> : null}
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
        <p className="text-muted-foreground text-sm">
          {kind}
          {mediaCount === 0 ? '' : t('invocations.invocationDetail.contextMessage.mediaCount', { count: mediaCount })}
        </p>
      ) : (
        <p className="text-sm break-words whitespace-pre-wrap">{text}</p>
      )}
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
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
          className="text-primary underline-offset-4 hover:underline"
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

export function AgentMessageCard({ message }: { readonly message: AgentMessageEntry }): React.ReactElement {
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
          <span className="text-sm">{meta.label}</span>
          {meta.note !== null ? <span className="text-muted-foreground text-xs">{meta.note}</span> : null}
          {message.role === 'assistant' ? <PrivateReasoningTag /> : null}
        </>
      }
      extra={formatTime(message.created_at)}
    >
      {message.role === 'assistant' && message.thinking_text.length > 0 ? (
        <div className="space-y-2">
          <LazyDetails
            summary={t('invocations.invocationDetail.agent.thinkingLabel')}
            summaryClassName="text-muted-foreground cursor-pointer text-xs"
            contentClassName="mt-1 text-sm break-words whitespace-pre-wrap"
          >
            {message.thinking_text}
          </LazyDetails>
          {message.text.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('invocations.invocationDetail.agent.noText')}</p>
          ) : (
            <p className="text-sm break-words whitespace-pre-wrap">{message.text}</p>
          )}
        </div>
      ) : message.text.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('invocations.invocationDetail.agent.noText')}</p>
      ) : message.role === 'tool_result' ? (
        <LazyDetails
          summary={t('invocations.invocationDetail.agent.viewToolResult')}
          summaryClassName="text-muted-foreground cursor-pointer text-xs"
          contentClassName="mt-1 text-sm break-words whitespace-pre-wrap"
        >
          {message.text}
        </LazyDetails>
      ) : (
        <p className="text-sm break-words whitespace-pre-wrap">{message.text}</p>
      )}
    </TimelineCard>
  );
}

export function ModelCallCard({ model }: { readonly model: ModelCallEntry }): React.ReactElement {
  const { t } = useTranslation();
  const hasDetails = model.error_detail !== null || model.request_json !== null || model.response_json !== null;
  return (
    <TimelineCard
      header={
        <>
          <ToneBadge tone="info">{t('invocations.invocationDetail.modelCall.badge')}</ToneBadge>
          <span className="text-sm font-medium">
            {model.provider}/{model.model}
          </span>
          <StateBadge state={model.state} />
        </>
      }
      extra={formatTime(model.created_at)}
    >
      <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
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
          <span className="text-destructive">
            {t('invocations.invocationDetail.modelCall.error', { code: model.error_code })}
          </span>
        ) : null}
      </div>
      {hasDetails ? (
        <LazyDetails
          summary={t('invocations.invocationDetail.modelCall.viewDetails')}
          summaryClassName="text-muted-foreground cursor-pointer text-xs"
          contentClassName="mt-2 space-y-2"
        >
          {model.error_detail !== null ? (
            <div>
              <p className="text-muted-foreground text-xs">
                {t('invocations.invocationDetail.modelCall.fullErrorDetails')}
              </p>
              <pre className="text-destructive mt-1 max-h-60 overflow-auto rounded border bg-muted/20 p-2 text-xs break-words whitespace-pre-wrap">
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
        <p className="text-muted-foreground text-xs">{t('invocations.invocationDetail.modelCall.rawUnavailable')}</p>
      ) : null}
    </TimelineCard>
  );
}
