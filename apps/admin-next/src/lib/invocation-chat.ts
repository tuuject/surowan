import type { ContextMessageEntry } from './api/contexts.ts';
import type {
  AgentMessageEntry,
  InvocationBucketEntry,
  InvocationDetail,
  TelegramSendEntry,
  ToolCallEntry,
  ToolContentPart,
} from './api/invocations.ts';
import {
  buildInvocationTimeline,
  type InvocationTimelineEvent,
  isNewContextSection,
  objectField,
  type ParsedSendArguments,
  parseJsonObject,
  parseSendObject,
  stringField,
  timelineEventKey,
} from './timeline.ts';

/**
 * Pure model for the Invocation "Overview" conversation: the run read as a chat.
 *
 * Built on the merged timeline (same ordering and event keys, so review
 * comments keep their anchors) and regrouped by batch: each batch the run took
 * opens with a divider, then the messages that arrived in it, then what the
 * model did after reading it. Replies (`send` / `send_reply`) stand alone; every
 * other model, tool and agent event between two replies collapses into one step
 * group. Retained history sits before the first batch.
 *
 * `position` numbers every reviewable event in display order. Events a reader
 * rarely needs (successful model calls, tool results, empty assistant turns) are
 * kept as `secondary` steps: the view hides them unless they carry a comment.
 */

type ContextEvent = Extract<InvocationTimelineEvent, { readonly kind: 'context_message' }>;
type ToolEvent = Extract<InvocationTimelineEvent, { readonly kind: 'tool_call' }>;
export type ChatActivityEvent = Extract<
  InvocationTimelineEvent,
  { readonly kind: 'model_call' | 'tool_call' | 'agent_message' }
>;

const REPLY_TOOLS: ReadonlySet<string> = new Set(['send', 'send_reply']);
const SYSTEM_SKILL_URI = /^system:\/\/\/skills\/([^/]+)\/SKILL\.md$/;
const MCP_SKILL_URI = /^mcp-skill:\/\/([^/]+)\/([^/]+)\/SKILL\.md$/;

/** A frozen chat message, read from its untrusted snapshot. */
export interface ChatMessage {
  readonly senderName: string | null;
  readonly username: string | null;
  /** Telegram sender id, or a room member ref. */
  readonly senderId: string | null;
  readonly text: string | null;
  readonly kind: string;
  readonly mediaCount: number;
  /** Telegram message id, or a room sequence. */
  readonly hostMessageId: string | null;
  readonly sentAt: string | null;
  readonly fromBot: boolean;
}

export type StepAction =
  | { readonly kind: 'skill'; readonly name: string }
  | { readonly kind: 'tool'; readonly name: string }
  | { readonly kind: 'tool_search'; readonly query: string }
  | { readonly kind: 'tool_help'; readonly name: string }
  | { readonly kind: 'private_text' }
  | { readonly kind: 'nudge' }
  | { readonly kind: 'tool_result' }
  | { readonly kind: 'agent_note'; readonly role: string }
  | { readonly kind: 'model_call'; readonly failed: boolean };

/** What a tool call handed back to the model; `null` when nothing was recorded. */
export interface ToolOutcome {
  readonly text: string | null;
  readonly content: readonly ToolContentPart[] | null;
}

export interface ChatStep {
  readonly event: ChatActivityEvent;
  readonly position: number;
  readonly action: StepAction;
  readonly secondary: boolean;
  /** The result of a tool call step; always `null` for model calls and agent messages. */
  readonly result: ToolOutcome | null;
}

export interface StepSummary {
  readonly tools: number;
  readonly skills: number;
  readonly failedModelCalls: number;
  readonly privateTexts: number;
}

export type ChatItem =
  | { readonly kind: 'member'; readonly event: ContextEvent; readonly position: number; readonly message: ChatMessage }
  | {
      readonly kind: 'reply';
      readonly event: ToolEvent;
      readonly position: number;
      readonly parts: readonly ParsedSendArguments[];
      /** Deliveries of this call in send order; empty when nothing went out. */
      readonly sends: readonly TelegramSendEntry[];
      readonly result: ToolOutcome | null;
    }
  | {
      readonly kind: 'steps';
      readonly key: string;
      readonly steps: readonly ChatStep[];
      readonly summary: StepSummary;
    };

/** `pending`: not read yet; `skipped`: the run ended before reading it. */
export type ChatBatchStatus = 'injected' | 'pending' | 'skipped';

export interface ChatBatch {
  readonly bucketId: string;
  readonly at: string;
  readonly status: ChatBatchStatus;
  readonly items: readonly ChatItem[];
}

export interface InvocationChat {
  readonly history: readonly ChatItem[];
  readonly batches: readonly ChatBatch[];
}

export function parseChatMessage(entry: ContextMessageEntry): ChatMessage {
  const snapshot = parseJsonObject(entry.snapshot_json);
  const sender = objectField(snapshot, 'sender');
  const media = snapshot?.media;
  return {
    senderName: stringField(sender, 'name'),
    username: stringField(sender, 'username'),
    senderId: stringField(sender, 'id') ?? stringField(sender, 'ref'),
    text: stringField(snapshot, 'text') ?? stringField(snapshot, 'caption'),
    kind: stringField(snapshot, 'kind') ?? 'message',
    mediaCount: Array.isArray(media) ? media.length : 0,
    hostMessageId: stringField(snapshot, 'message_id'),
    sentAt: stringField(snapshot, 'telegram_date') ?? stringField(snapshot, 'sent_at'),
    fromBot: snapshot?.sent_by_bot === true,
  };
}

/** Every message one `send` or `send_reply` call asked for, in order. */
export function parseReplyParts(tool: ToolCallEntry): readonly ParsedSendArguments[] {
  const args = parseJsonObject(tool.arguments_json);
  if (tool.tool_name !== 'send_reply') {
    return [parseSendObject(args)];
  }
  const rawParts = args?.parts;
  if (!Array.isArray(rawParts) || rawParts.length === 0) {
    return [parseSendObject(null)];
  }
  // reply_to_message_id is a call-level field that applies to the first part only.
  const replyTo = parseSendObject(args).reply_to_message_id;
  return rawParts.map((part: unknown, index) => {
    const parsed = parseSendObject(
      typeof part === 'object' && part !== null && !Array.isArray(part)
        ? (part as Readonly<Record<string, unknown>>)
        : null,
    );
    return index === 0 && parsed.reply_to_message_id === null ? { ...parsed, reply_to_message_id: replyTo } : parsed;
  });
}

function skillName(uri: string): string | null {
  const system = SYSTEM_SKILL_URI.exec(uri);
  if (system?.[1] !== undefined) {
    return system[1];
  }
  const mcp = MCP_SKILL_URI.exec(uri);
  return mcp?.[1] !== undefined && mcp[2] !== undefined ? `${mcp[1]}/${mcp[2]}` : null;
}

function toolAction(tool: ToolCallEntry): StepAction {
  const args = parseJsonObject(tool.arguments_json);
  if (tool.tool_name === 'read') {
    const uri = stringField(args, 'uri');
    const skill = uri === null ? null : skillName(uri);
    if (skill !== null) {
      return { kind: 'skill', name: skill };
    }
  }
  if (tool.tool_name === 'execute') {
    const action = stringField(args, 'action');
    const name = stringField(args, 'tool');
    const query = stringField(args, 'query');
    if (action === 'call' && name !== null) {
      return { kind: 'tool', name };
    }
    if (action === 'help' && name !== null) {
      return { kind: 'tool_help', name };
    }
    if (action === 'search' && query !== null) {
      return { kind: 'tool_search', query };
    }
  }
  return { kind: 'tool', name: tool.tool_name };
}

function classifyStep(event: ChatActivityEvent): { readonly action: StepAction; readonly secondary: boolean } {
  switch (event.kind) {
    case 'model_call': {
      const failed = event.model.state !== 'success' && event.model.state !== 'pending';
      return { action: { kind: 'model_call', failed }, secondary: !failed };
    }
    case 'tool_call':
      return { action: toolAction(event.tool), secondary: false };
    case 'agent_message': {
      const { message } = event;
      switch (message.role) {
        case 'assistant':
          return {
            action: { kind: 'private_text' },
            secondary: message.text.trim().length === 0 && message.thinking_text.trim().length === 0,
          };
        case 'tool_result':
          return { action: { kind: 'tool_result' }, secondary: true };
        case 'harness_nudge':
          return { action: { kind: 'nudge' }, secondary: false };
        default:
          return { action: { kind: 'agent_note', role: message.role }, secondary: false };
      }
    }
  }
}

/**
 * The result as the model received it (its `tool_result` message, which for a
 * failed call is the only place the error text lives), else the copy the call
 * recorded itself, as runs from before tool results were kept only have that.
 */
function toolOutcome(tool: ToolCallEntry, received: AgentMessageEntry | undefined): ToolOutcome | null {
  const text = received !== undefined && received.text.length > 0 ? received.text : tool.result_text;
  const content = received?.result_content ?? tool.result_content ?? null;
  const hasText = text !== null && text.length > 0;
  const hasContent = content !== null && content.length > 0;
  return hasText || hasContent ? { text: hasText ? text : null, content: hasContent ? content : null } : null;
}

const EMPTY_SUMMARY: StepSummary = { tools: 0, skills: 0, failedModelCalls: 0, privateTexts: 0 };

export function summarizeSteps(steps: readonly ChatStep[]): StepSummary {
  let tools = 0;
  let skills = 0;
  let failedModelCalls = 0;
  let privateTexts = 0;
  for (const { action, secondary } of steps) {
    if (secondary) {
      continue;
    }
    switch (action.kind) {
      case 'skill':
        skills += 1;
        break;
      case 'tool':
      case 'tool_search':
      case 'tool_help':
        tools += 1;
        break;
      case 'model_call':
        failedModelCalls += action.failed ? 1 : 0;
        break;
      case 'private_text':
        privateTexts += 1;
        break;
      default:
        break;
    }
  }
  return { tools, skills, failedModelCalls, privateTexts };
}

function timeOf(value: string | null): number {
  return value === null ? Number.NaN : Date.parse(value);
}

interface BatchSlot {
  readonly bucket: InvocationBucketEntry;
  readonly messages: ContextEvent[];
  readonly activity: ChatActivityEvent[];
}

/**
 * The batches in reading order: the opening batch, then attached batches by
 * the time the model read them, then the ones it never read. The opening batch
 * is synthesized for runs recorded before batches were kept.
 */
function orderBatches(invocation: InvocationDetail): {
  readonly opening: InvocationBucketEntry;
  readonly read: readonly InvocationBucketEntry[];
  readonly unread: readonly InvocationBucketEntry[];
} {
  const opening = invocation.buckets.find((entry) => entry.bucket_id === invocation.bucket_id) ?? {
    bucket_id: invocation.bucket_id,
    attached_at: invocation.created_at,
    injected_at: null,
  };
  const attached = invocation.buckets.filter((entry) => entry.bucket_id !== invocation.bucket_id);
  const read = attached
    .filter((entry) => !Number.isNaN(timeOf(entry.injected_at)))
    .sort((left, right) => timeOf(left.injected_at) - timeOf(right.injected_at));
  const unread = attached.filter((entry) => Number.isNaN(timeOf(entry.injected_at)));
  return { opening, read, unread };
}

function batchStatus(invocation: InvocationDetail, bucket: InvocationBucketEntry, isOpening: boolean): ChatBatchStatus {
  // Runs recorded before injection times were kept only know that they started.
  if (bucket.injected_at !== null || (isOpening && invocation.started_at !== null)) {
    return 'injected';
  }
  return invocation.finished_at === null ? 'pending' : 'skipped';
}

export function buildInvocationChat(invocation: InvocationDetail): InvocationChat {
  const { opening, read, unread } = orderBatches(invocation);
  const slots = new Map<string, BatchSlot>();
  for (const bucket of [opening, ...read, ...unread]) {
    slots.set(bucket.bucket_id, { bucket, messages: [], activity: [] });
  }
  const openingSlot = slots.get(opening.bucket_id) as BatchSlot;
  const history: ContextEvent[] = [];

  for (const event of buildInvocationTimeline(invocation)) {
    switch (event.kind) {
      case 'queued':
      case 'started':
      case 'finished':
        break;
      case 'context_message':
        if (!isNewContextSection(event.message.section)) {
          history.push(event);
        } else {
          const sourceId = event.message.source_bucket_id;
          (slots.get(sourceId ?? opening.bucket_id) ?? openingSlot).messages.push(event);
        }
        break;
      default: {
        // The latest batch read at or before this event; the opening batch
        // takes everything earlier and every event without a readable time.
        const at = timeOf(event.at);
        const owner = [...read].reverse().find((bucket) => timeOf(bucket.injected_at) <= at);
        (owner === undefined ? openingSlot : (slots.get(owner.bucket_id) ?? openingSlot)).activity.push(event);
      }
    }
  }

  let position = 0;
  const next = (): number => {
    position += 1;
    return position - 1;
  };
  const memberItem = (event: ContextEvent): ChatItem => ({
    kind: 'member',
    event,
    position: next(),
    message: parseChatMessage(event.message),
  });
  const resultsByCall = new Map<string, AgentMessageEntry>();
  for (const message of invocation.agent_messages) {
    if (message.role === 'tool_result' && typeof message.tool_call_id === 'string') {
      resultsByCall.set(message.tool_call_id, message);
    }
  }
  const sendsByCall = new Map<string, TelegramSendEntry[]>();
  for (const send of invocation.telegram_sends) {
    const list = sendsByCall.get(send.tool_call_id) ?? [];
    list.push(send);
    sendsByCall.set(send.tool_call_id, list);
  }

  const historyItems = history.map(memberItem);
  const batches = [...slots.values()].map((slot): ChatBatch => {
    const items: ChatItem[] = slot.messages.map(memberItem);
    let group: ChatStep[] | null = null;
    for (const event of slot.activity) {
      if (event.kind === 'tool_call' && REPLY_TOOLS.has(event.tool.tool_name)) {
        group = null;
        items.push({
          kind: 'reply',
          event,
          position: next(),
          parts: parseReplyParts(event.tool),
          sends: sendsByCall.get(event.tool.tool_call_id) ?? [],
          result: toolOutcome(event.tool, resultsByCall.get(event.tool.tool_call_id)),
        });
        continue;
      }
      if (group === null) {
        group = [];
        // Keyed by its first event, so a running run appending steps keeps the key.
        items.push({ kind: 'steps', key: `steps-${timelineEventKey(event)}`, steps: group, summary: EMPTY_SUMMARY });
      }
      group.push({
        event,
        position: next(),
        ...classifyStep(event),
        result: event.kind === 'tool_call' ? toolOutcome(event.tool, resultsByCall.get(event.tool.tool_call_id)) : null,
      });
    }
    const isOpening = slot === openingSlot;
    return {
      bucketId: slot.bucket.bucket_id,
      at: slot.bucket.injected_at ?? (isOpening ? invocation.started_at : null) ?? slot.bucket.attached_at,
      status: batchStatus(invocation, slot.bucket, isOpening),
      items: items.map((item) => (item.kind === 'steps' ? { ...item, summary: summarizeSteps(item.steps) } : item)),
    };
  });
  return { history: historyItems, batches };
}
