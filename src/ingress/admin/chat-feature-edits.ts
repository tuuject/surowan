import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import type { FileConfig } from '../../platform/config/index.ts';
import type { ConfigEdit } from '../../platform/config/write.ts';
import { AdminQueryError } from './audit/shared.ts';
import { chatIndex, fileChats } from './chats.ts';

/**
 * Per-Chat feature writes that only touch one nested section of a Chat entry:
 * participation windows, proactive reply odds, group memory and the `/pause`
 * permission. They live beside `chats.ts` so the allowlist/model/delete logic
 * there stays readable, and every write still goes through the same
 * `ConfigEdit` + revision path.
 */

// Mirrors the config file's ParticipationWindowSchema so the panel cannot write
// windows the configuration would reject. `end` additionally accepts `24:00`.
const ParticipationWindowSchema = Type.Object(
  {
    start: Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }),
    end: Type.String({ pattern: '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$' }),
    days: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { minItems: 1, uniqueItems: true })),
  },
  { additionalProperties: false },
);
const ParticipationBodySchema = Type.Object(
  {
    // `null` removes the Chat's active windows (inheriting the global schedule
    // or, without one, staying unrestricted); an array - including an empty one,
    // which keeps the chat trigger-only - replaces them wholesale.
    active_windows: Type.Union([Type.Array(ParticipationWindowSchema), Type.Null()]),
  },
  { additionalProperties: false },
);
const participationValidator = Compile(ParticipationBodySchema);
const ProbabilitySchema = Type.Number({ minimum: 0, maximum: 1 });
const ProactiveReplyBodySchema = Type.Union([
  Type.Object({ mode: Type.Literal('inherit') }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal('off') }, { additionalProperties: false }),
  Type.Object(
    {
      mode: Type.Literal('custom'),
      base_probability: ProbabilitySchema,
      increment: ProbabilitySchema,
      hard_pity: Type.Integer({ minimum: 1, maximum: 100 }),
    },
    { additionalProperties: false },
  ),
]);
const proactiveReplyValidator = Compile(ProactiveReplyBodySchema);
const GroupMemoryBodySchema = Type.Object(
  {
    enabled: Type.Boolean(),
    idle_minutes: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 1_440 }), Type.Null()])),
  },
  { additionalProperties: false },
);
const groupMemoryValidator = Compile(GroupMemoryBodySchema);
const PausePolicyBodySchema = Type.Object({ pause_by_members: Type.Boolean() }, { additionalProperties: false });
const pausePolicyValidator = Compile(PausePolicyBodySchema);

export type ParticipationBody = Static<typeof ParticipationBodySchema>;

export function parseParticipation(value: unknown): ParticipationBody {
  if (!participationValidator.Check(value)) {
    throw new AdminQueryError(
      'invalid_body',
      'Expected active_windows: either null to remove the Chat schedule or an array of { start, end, days? } windows',
    );
  }
  return value;
}

export type GroupMemoryBody = Static<typeof GroupMemoryBodySchema>;

export function parseGroupMemory(value: unknown): GroupMemoryBody {
  if (!groupMemoryValidator.Check(value)) {
    throw new AdminQueryError('invalid_body', 'Expected { enabled: boolean, idle_minutes?: 1-1440 | null }');
  }
  return value;
}

export type PausePolicyBody = Static<typeof PausePolicyBodySchema>;

export function parsePausePolicy(value: unknown): PausePolicyBody {
  if (!pausePolicyValidator.Check(value)) {
    throw new AdminQueryError('invalid_body', 'Expected { pause_by_members: boolean }');
  }
  return value;
}

export type ProactiveReplyBody = Static<typeof ProactiveReplyBodySchema>;

export function parseProactiveReply(value: unknown): ProactiveReplyBody {
  if (!proactiveReplyValidator.Check(value)) {
    throw new AdminQueryError(
      'invalid_body',
      'Expected { mode: "inherit" | "off" } or { mode: "custom", base_probability, increment, hard_pity }',
    );
  }
  return value;
}

/**
 * Edits only the Chat's `participation.active_windows`. Other participation
 * fields (trigger keywords, attention window) are preserved, because they are
 * edited elsewhere and would silently disappear with the object. Removing the
 * windows of an object that carries nothing else removes the object itself: a
 * leftover empty `participation: {}` would keep the participation gate active
 * and turn the Chat trigger-only instead of restoring the inherited behavior.
 */
export function updateChatParticipation(file: FileConfig, id: number, body: ParticipationBody): ConfigEdit[] {
  const index = chatIndex(file, id);
  const chat = fileChats(file)[index];
  if (chat === undefined) {
    throw new AdminQueryError('chat_not_found', `Chat ${id} is not configured in the file`, 404);
  }
  if (chat.id > 0 && body.active_windows !== null) {
    throw new AdminQueryError('invalid_body', 'Private chats cannot configure participation windows');
  }
  for (const window of body.active_windows ?? []) {
    if (window.start === window.end) {
      throw new AdminQueryError('invalid_body', `An active window cannot be empty: ${window.start}-${window.end}`);
    }
  }
  const current = chat.participation;
  if (body.active_windows === null) {
    if (current?.active_windows === undefined) {
      return [];
    }
    const { active_windows: _removed, ...rest } = current;
    if (Object.keys(rest).length === 0) {
      return [{ path: ['telegram', 'chats', index, 'participation'], value: undefined }];
    }
    return [{ path: ['telegram', 'chats', index, 'participation', 'active_windows'], value: undefined }];
  }
  if (JSON.stringify(current?.active_windows) === JSON.stringify(body.active_windows)) {
    return [];
  }
  return [{ path: ['telegram', 'chats', index, 'participation', 'active_windows'], value: body.active_windows }];
}

/** Edits only the Chat's `group_memory` switch, preserving every other field. */
export function updateChatGroupMemory(file: FileConfig, id: number, body: GroupMemoryBody): ConfigEdit[] {
  const index = chatIndex(file, id);
  const current = fileChats(file)[index]?.group_memory;
  const idleMinutes = body.idle_minutes === null ? undefined : (body.idle_minutes ?? current?.idle_minutes);
  const value = { enabled: body.enabled, ...(idleMinutes === undefined ? {} : { idle_minutes: idleMinutes }) };
  if (JSON.stringify(current) === JSON.stringify(value)) {
    return [];
  }
  return [{ path: ['telegram', 'chats', index, 'group_memory'], value }];
}

/**
 * Edits only the Chat's `pause_by_members` switch, preserving every other field.
 * The switch covers `/pause` alone: `/resume` stays admin-only, and a private
 * chat has no members to open it to.
 */
export function updateChatPausePolicy(file: FileConfig, id: number, body: PausePolicyBody): ConfigEdit[] {
  const index = chatIndex(file, id);
  const chat = fileChats(file)[index];
  if (chat === undefined) {
    throw new AdminQueryError('chat_not_found', `Chat ${id} is not configured in the file`, 404);
  }
  if (chat.id > 0) {
    throw new AdminQueryError('invalid_body', 'Private chats cannot open /pause to members');
  }
  if ((chat.pause_by_members ?? false) === body.pause_by_members) {
    return [];
  }
  // An absent key already means admins-only, so disabling deletes it instead of
  // leaving an explicit `false` behind.
  return [{ path: ['telegram', 'chats', index, 'pause_by_members'], value: body.pause_by_members ? true : undefined }];
}

/** Edits only the Chat's `proactive_reply` override, preserving every other field. */
export function updateChatProactiveReply(file: FileConfig, id: number, body: ProactiveReplyBody): ConfigEdit[] {
  const index = chatIndex(file, id);
  const chat = fileChats(file)[index];
  if (chat === undefined) {
    throw new AdminQueryError('chat_not_found', `Chat ${id} is not configured in the file`, 404);
  }
  if (chat.id > 0) {
    throw new AdminQueryError('invalid_body', 'Private chats cannot configure proactive replies');
  }
  const value =
    body.mode === 'inherit'
      ? undefined
      : body.mode === 'off'
        ? { enabled: false }
        : {
            enabled: true,
            base_probability: body.base_probability,
            increment: body.increment,
            hard_pity: body.hard_pity,
          };
  if (JSON.stringify(chat.proactive_reply) === JSON.stringify(value)) {
    return [];
  }
  return [{ path: ['telegram', 'chats', index, 'proactive_reply'], value }];
}
