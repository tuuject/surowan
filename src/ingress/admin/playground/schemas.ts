/**
 * Schemas, validators and refusals for the Admin Playground API. Bodies are
 * checked here before a route touches the room store, and a refusal carries the
 * HTTP status the panel shows.
 */
import Type from 'typebox';
import { Compile } from 'typebox/compile';

/** Room titles and identity names: printable, bounded, no control characters. */
const NAME_TEXT = Type.String({ minLength: 1, maxLength: 120, pattern: '^[^\\u0000-\\u001f\\u007f]+$' });
const REQUEST_KEY = Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_.:-]+$' });
/** A canonical unsigned int64 in decimal: no sign, no leading zero. */
const DECIMAL_ID = Type.String({ pattern: '^(0|[1-9][0-9]{0,18})$' });
const ROLE = Type.Union([Type.Literal('member'), Type.Literal('admin')]);
const RESOURCE_ID = Type.String({ pattern: '^[1-9][0-9]{0,18}$' });
/** One message may carry at most four pictures, matching the input limit. */
const MAX_MESSAGE_IMAGES = 4;
/** A room picture is at most 10 MiB; base64 adds a third, so this is the cap. */
export const MAX_UPLOAD_TEXT_BYTES = 15_000_000;
/** Text length limit of one message, in characters (UTF-16 code units). */
const MAX_MESSAGE_TEXT = 16_384;
/**
 * The read limit is in encoded bytes while the text limit is in characters: a
 * `\uXXXX` escape spends six bytes on one code unit, so the worst valid text
 * plus the other fields still fits.
 */
export const MAX_MESSAGE_BODY_BYTES = MAX_MESSAGE_TEXT * 6 + 8_192;
/** Most members a room may be created with. */
const MAX_ROOM_MEMBERS = 64;
/**
 * The same escape bound for room creation: a title and every member name may
 * spend six bytes per character, plus the field names around each member.
 */
export const MAX_ROOM_BODY_BYTES = (MAX_ROOM_MEMBERS + 1) * (120 * 6 + 64) + 8_192;
/** SQLite INTEGER is a signed 64-bit value; a larger id cannot be bound. */
export const MAX_ID = 9_223_372_036_854_775_807n;

export const createRoomValidator = Compile(
  Type.Object(
    {
      title: NAME_TEXT,
      members: Type.Optional(
        Type.Array(Type.Object({ name: NAME_TEXT, role: Type.Optional(ROLE) }, { additionalProperties: false }), {
          maxItems: MAX_ROOM_MEMBERS,
        }),
      ),
      request_key: REQUEST_KEY,
    },
    { additionalProperties: false },
  ),
);
export const participantValidator = Compile(
  Type.Object(
    {
      name: NAME_TEXT,
      role: Type.Optional(ROLE),
      request_key: REQUEST_KEY,
    },
    { additionalProperties: false },
  ),
);
export const messageValidator = Compile(
  Type.Object(
    {
      request_key: REQUEST_KEY,
      sender_id: RESOURCE_ID,
      text: Type.Optional(Type.String({ maxLength: MAX_MESSAGE_TEXT })),
      reply_to_seq: Type.Optional(Type.Union([RESOURCE_ID, Type.Null()])),
      asset_ids: Type.Optional(
        Type.Array(Type.String({ minLength: 32, maxLength: 32, pattern: '^[a-f0-9]{32}$' }), {
          maxItems: MAX_MESSAGE_IMAGES,
        }),
      ),
    },
    { additionalProperties: false },
  ),
);
export const releaseValidator = Compile(
  Type.Object(
    {
      request_key: REQUEST_KEY,
      revision: DECIMAL_ID,
      // A room with no admitted input releases through seq 0: the boundary is a
      // count, not an identity, so zero is a valid value here.
      through_seq: DECIMAL_ID,
    },
    { additionalProperties: false },
  ),
);
export const retryValidator = Compile(Type.Object({ attempt_key: REQUEST_KEY }, { additionalProperties: false }));
export const capabilitiesValidator = Compile(
  Type.Object({ image_enabled: Type.Boolean(), revision: DECIMAL_ID }, { additionalProperties: false }),
);
export const uploadValidator = Compile(
  Type.Object(
    {
      content_base64: Type.String({ minLength: 1, maxLength: MAX_UPLOAD_TEXT_BYTES }),
      mime: Type.String({ minLength: 1, maxLength: 80 }),
      name: Type.Optional(Type.String({ maxLength: 120 })),
    },
    { additionalProperties: false },
  ),
);

/** Domain refusals map onto HTTP the way the panel shows them. */
export const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  room_not_found: 404,
  unknown_release: 404,
  unknown_sender: 404,
  unknown_asset: 404,
  unknown_input: 404,
  room_revision_mismatch: 409,
  release_conflict: 409,
  retry_refused: 409,
  input_conflict: 409,
  room_not_held: 409,
};

export class PlaygroundAdminError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Validates one request body against its schema. The validator's own type
 * predicate is kept in the signature, so a checked body is the schema's type
 * without an assertion.
 */
export function requireValid<T>(validator: { Check(value: unknown): value is T }, value: unknown, label: string): T {
  if (!validator.Check(value)) {
    throw new PlaygroundAdminError('invalid_body', `${label} is invalid`, 400);
  }
  return value;
}
