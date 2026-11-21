import type { DecisionMessageRow } from './query.ts';
import type { DecisionMessage, DecisionState } from './types.ts';

/** The evaluation's cut; changing it invalidates the calibrated threshold. */
const TEXT_LIMIT = 500;
const REPLY_LIMIT = 80;

/**
 * Renders the `state` of one decision exactly as the offline evaluation fed the
 * model. These rules were in force when the threshold was measured, so they must
 * not drift:
 *
 * - `from` is the sender's display name, or `<bot> [bot]` for the bot's own
 *   message.
 * - `text` is `text`, else `caption`, cut to 500 characters; a non-text kind is
 *   prefixed with `[kind]` (`[photo] caption`, `[sticker]`).
 * - `reply_to` appears only when the message carries a reply snapshot, written
 *   as `<sender>: <body cut to 80 characters>` with the bot as `<bot> [bot]`.
 *
 * Message content goes only into `state`. The instructions hold the question,
 * and the service's messages are untrusted data wherever they sit.
 */
export function renderDecisionState(input: {
  readonly history: readonly DecisionMessageRow[];
  readonly pending: readonly DecisionMessageRow[];
  readonly bot: { readonly name: string; readonly username: string };
}): DecisionState {
  return {
    bot: { name: input.bot.name, username: input.bot.username },
    history: input.history.map((row) => renderMessage(row, input.bot.name)),
    pending: input.pending.map((row) => renderMessage(row, input.bot.name)),
  };
}

function renderMessage(row: DecisionMessageRow, botName: string): DecisionMessage {
  const body = row.text ?? row.caption ?? '';
  const text = row.kind === 'text' ? body : body.length === 0 ? `[${row.kind}]` : `[${row.kind}] ${body}`;
  const message: DecisionMessage = {
    from: row.sent_by_bot === 1n ? `${botName} [bot]` : (row.sender_display_name ?? 'unknown'),
    text: cut(text, TEXT_LIMIT),
  };
  const reply = renderReply(row, botName);
  return reply === undefined ? message : { ...message, reply_to: reply };
}

function renderReply(row: DecisionMessageRow, botName: string): string | undefined {
  if (row.reply_snapshot_json === null) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.reply_snapshot_json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const snapshot = parsed as { sender?: unknown; content?: unknown };
  const sender =
    row.reply_from_bot === 1n
      ? `${botName} [bot]`
      : typeof snapshot.sender === 'string' && snapshot.sender.length > 0
        ? snapshot.sender
        : 'unknown';
  const content = typeof snapshot.content === 'string' ? snapshot.content : '';
  return `${sender}: ${cut(content, REPLY_LIMIT)}`;
}

/** Cuts by code point, so a truncated emoji or CJK character stays one character. */
function cut(value: string, limit: number): string {
  return value.length <= limit ? value : Array.from(value).slice(0, limit).join('');
}
