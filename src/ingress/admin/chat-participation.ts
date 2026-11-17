import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import type { FileConfig } from '../../platform/config/index.ts';
import type { ConfigEdit } from '../../platform/config/write.ts';
import { AdminQueryError } from './audit/shared.ts';

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
    active_windows: Type.Optional(Type.Union([Type.Array(ParticipationWindowSchema), Type.Null()])),
    ask_only: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  },
  { additionalProperties: false, minProperties: 1 },
);
const participationValidator = Compile(ParticipationBodySchema);
export type ParticipationBody = Static<typeof ParticipationBodySchema>;

export function parseParticipation(value: unknown): ParticipationBody {
  if (!participationValidator.Check(value)) {
    throw new AdminQueryError(
      'invalid_body',
      'Expected active_windows (array or null) and/or ask_only (boolean or null)',
    );
  }
  return value;
}

/** Patch managed overrides while preserving keywords and attention settings. */
export function updateChatParticipation(file: FileConfig, id: number, body: ParticipationBody): ConfigEdit[] {
  const index = file.telegram?.chats.findIndex((chat) => chat.id === id) ?? -1;
  const chat = file.telegram?.chats[index];
  if (chat === undefined) {
    throw new AdminQueryError('chat_not_found', `Chat ${id} is not configured in the file`, 404);
  }
  if (chat.id > 0) {
    throw new AdminQueryError('invalid_body', 'Private chats cannot configure participation');
  }
  for (const window of body.active_windows ?? []) {
    if (window.start === window.end) {
      throw new AdminQueryError('invalid_body', 'An active window cannot be empty');
    }
  }
  const next = { ...chat.participation };
  if (body.active_windows === null) {
    delete next.active_windows;
  } else if (body.active_windows !== undefined) {
    next.active_windows = body.active_windows;
  }
  if (body.ask_only === null) {
    delete next.ask_only;
  } else if (body.ask_only !== undefined) {
    next.ask_only = body.ask_only;
  }
  const value = Object.keys(next).length === 0 ? undefined : next;
  if (JSON.stringify(value) === JSON.stringify(chat.participation)) {
    return [];
  }
  const path = ['telegram', 'chats', index, 'participation'];
  if (value === undefined) {
    return [{ path, value: undefined }];
  }
  return (['active_windows', 'ask_only'] as const).flatMap((field) =>
    JSON.stringify(chat.participation?.[field]) === JSON.stringify(next[field])
      ? []
      : [{ path: [...path, field], value: next[field] }],
  );
}
