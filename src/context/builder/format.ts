import { renderSpoilers, type SpoilerRange } from '../../platform/spoilers.ts';
import type { FormatOptions, PreparedSnapshot, ReplySnapshot } from './schema.ts';

/**
 * Renders one Telegram snapshot as a compact header plus indented body:
 *
 *   [156063 23:09:39 re:156048 uid:6869211498 @aac6fef] 雨夹雪
 *     > Mio Akiyama: 我去
 *     超级优质客户
 *
 * The bracket holds only runtime-controlled tokens and the display name follows
 * it on a single line. Every Telegram-controlled line is indented, so no message
 * content can forge a header, a runtime block tag, or a readback line.
 */
export function formatSnapshot(snapshot: PreparedSnapshot, options: FormatOptions): string {
  const tokens = [snapshot.message_id, formatTime(snapshot.telegram_date, options.timezone, options.now)];
  if (options.showTopic && snapshot.message_thread_id !== undefined) {
    tokens.push(`topic:${snapshot.message_thread_id}`);
  }
  if (snapshot.sent_by_bot) {
    tokens.push('you');
  }
  if (snapshot.reply_to_message_id !== null) {
    tokens.push(`re:${snapshot.reply_to_message_id}`);
  }
  if (snapshot.sender.id !== null) {
    tokens.push(`uid:${snapshot.sender.id}`);
  }
  if (snapshot.sender.username !== null && USERNAME.test(snapshot.sender.username)) {
    tokens.push(`@${snapshot.sender.username}`);
  }
  const name = singleLine(snapshot.sender.name ?? 'unknown');
  return [`[${tokens.join(' ')}] ${name}`, ...snapshotBody(snapshot, options).map((line) => `  ${line}`)].join('\n');
}

/**
 * A room message, in the room's own wording.
 *
 * The header keeps only room tokens: the room sequence the model may reply to,
 * a room-scoped `member:` ref, and the reply edge. Telegram's `uid:` and `@`
 * tokens never appear, because a room's member id is not a Telegram user id.
 */
export function formatRoomSnapshot(snapshot: PreparedSnapshot, options: FormatOptions): string {
  const tokens = [snapshot.message_id, formatTime(snapshot.telegram_date, options.timezone, options.now)];
  if (options.showTopic && snapshot.message_thread_id !== undefined) {
    tokens.push(`topic:${snapshot.message_thread_id}`);
  }
  if (snapshot.sent_by_bot) {
    tokens.push('you');
  }
  if (snapshot.reply_to_message_id !== null) {
    tokens.push(`re:${snapshot.reply_to_message_id}`);
  }
  tokens.push(`member:${snapshot.senderRef ?? 'unknown'}`);
  const name = singleLine(snapshot.sender.name ?? 'unknown');
  return [`[${tokens.join(' ')}] ${name}`, ...snapshotBody(snapshot, options).map((line) => `  ${line}`)].join('\n');
}

function snapshotBody(snapshot: PreparedSnapshot, options: FormatOptions): string[] {
  const body: string[] = [];
  const forwardedFrom = forwardOriginName(snapshot.forward_origin);
  if (forwardedFrom !== null) {
    body.push(`(forwarded from ${singleLine(forwardedFrom)})`);
  }
  const reply = replySnapshot(snapshot.reply_snapshot);
  if (
    reply !== null &&
    snapshot.reply_to_message_id !== null &&
    !options.inlineReplies.has(snapshot.reply_to_message_id)
  ) {
    body.push(`> ${singleLine(reply.sender)}: ${singleLine(renderSpoilers(reply.content, snapshot.spoilers?.reply))}`);
  }
  // The body stays exactly what the sender wrote; a spoiler only adds the tag
  // that says a human folded this span, so the model can weigh what it reads
  // without ever losing the text itself.
  const bodies: readonly (readonly [string | null, readonly SpoilerRange[] | undefined])[] = [
    [snapshot.text, snapshot.spoilers?.text],
    [snapshot.caption, snapshot.spoilers?.caption],
  ];
  for (const [content, spoilers] of bodies) {
    if (content !== null) {
      body.push(...renderSpoilers(content, spoilers).split('\n'));
    }
  }
  for (const media of snapshot.media) {
    const size = media.width === null || media.height === null ? '' : ` ${media.width}x${media.height}`;
    const figure = media.figure === undefined ? '' : `${media.figure} `;
    body.push(`[${media.kind} ${figure}${media.image_ref}${size}]`);
  }
  if (body.length === 0) {
    body.push(`[${snapshot.kind}]`);
  }
  return body;
}

const USERNAME = /^[A-Za-z0-9_]+$/;
const HEADER = /^\[([1-9][0-9]*) ([^\]\n]*)\] (.*)$/;

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Chat-local time; the date is shown only when it differs from the batch's current date. */
function formatTime(iso: string, timezone: string, now: Date): string {
  const parts = (date: Date): Record<string, string> =>
    Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(date)
        .map((part) => [part.type, part.value]),
    );
  const at = parts(new Date(iso));
  const today = parts(now);
  const time = `${at.hour}:${at.minute}:${at.second}`;
  return at.year === today.year && at.month === today.month && at.day === today.day
    ? time
    : `${at.year}-${at.month}-${at.day}T${time}`;
}

function replySnapshot(value: unknown): ReplySnapshot | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { sender, content } = value as Record<string, unknown>;
  return typeof sender === 'string' && typeof content === 'string' ? { sender, content } : null;
}

/** The display name of a Telegram MessageOrigin, stored verbatim from the Bot API. */
function forwardOriginName(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const origin = value as Record<string, unknown>;
  const title = (chat: unknown): string | null => {
    const value = typeof chat === 'object' && chat !== null ? (chat as Record<string, unknown>).title : undefined;
    return typeof value === 'string' ? value : null;
  };
  switch (origin.type) {
    case 'user': {
      const user = origin.sender_user;
      if (typeof user !== 'object' || user === null) {
        return null;
      }
      const { first_name: first, last_name: last } = user as Record<string, unknown>;
      return [first, last].filter((part): part is string => typeof part === 'string').join(' ') || null;
    }
    case 'hidden_user':
      return typeof origin.sender_user_name === 'string' ? origin.sender_user_name : null;
    case 'chat':
      return title(origin.sender_chat);
    case 'channel':
      return title(origin.chat);
    default:
      return 'unknown';
  }
}

export interface RenderedHeader {
  readonly message_id: string;
  readonly sender: { readonly id: string | null; readonly name: string; readonly username: string | null };
}

/**
 * Reads back the message headers `renderInjection` wrote into a batch. Only
 * lines after the last `</runtime_state>` line count: the runtime block quotes
 * model- and tool-authored text, while every Telegram-authored line below it is
 * indented and can never match a header.
 */
export function parseSnapshotLines(text: string): RenderedHeader[] {
  const lines = text.split('\n');
  const start = lines.lastIndexOf('</runtime_state>') + 1;
  const headers: RenderedHeader[] = [];
  for (const line of lines.slice(start)) {
    const match = HEADER.exec(line);
    if (match === null) {
      continue;
    }
    const [, messageId = '', bracket = '', name = ''] = match;
    const tokens = bracket.split(' ');
    const uid = tokens.find((token) => /^uid:[0-9]+$/.test(token));
    const username = tokens.find((token) => token.startsWith('@'));
    headers.push({
      message_id: messageId,
      sender: {
        id: uid === undefined ? null : uid.slice(4),
        name,
        username: username === undefined ? null : username.slice(1),
      },
    });
  }
  return headers;
}
