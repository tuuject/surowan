import Type from 'typebox';
import Compile from 'typebox/compile';
import type { FileConfig } from '../../../platform/config/index.ts';
import { STICKER_SET_NOTE_MAX_LENGTH } from '../../../platform/config/schema.ts';
import type { ConfigController } from '../../../platform/config/write.ts';
import type { SecretStore } from '../../../platform/secrets.ts';
import type { Orm } from '../../../store/store.ts';
import { AdminQueryError } from '../audit/shared.ts';
import { listStickerSets } from '../audit/stickers.ts';
import { CONFIG_WRITE_STATUS, readConfigFile } from '../config-file.ts';
import { decodeSegments, json, readJsonObject, redact, requiredRevision, revisionRequired } from '../http.ts';

export interface StickerSetsAdminDeps {
  readonly orm: Orm;
  readonly configReloader: ConfigController | undefined;
  readonly secrets: SecretStore | undefined;
}

type StickerSetEntry = NonNullable<NonNullable<FileConfig['telegram']>['sticker_sets']>[number];

const ALIAS_PATTERN = '^[A-Za-z][A-Za-z0-9_-]{0,63}$';
/** Telegram set names: letters, digits and underscores. */
const SET_NAME = /^[A-Za-z0-9_]{1,64}$/;
/** The share link Telegram shows for a set, so an operator can paste it as is. */
const SET_LINK = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/addstickers\/([A-Za-z0-9_]{1,64})\/?$/i;

// The note limit is checked after trimming, so the raw field allows the padding.
const NoteSchema = Type.Union([Type.String({ maxLength: STICKER_SET_NOTE_MAX_LENGTH * 2 }), Type.Null()]);
const AddBodySchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    alias: Type.String({ pattern: ALIAS_PATTERN }),
    note: Type.Optional(NoteSchema),
  },
  { additionalProperties: false },
);
const UpdateBodySchema = Type.Object(
  {
    alias: Type.Optional(Type.String({ pattern: ALIAS_PATTERN })),
    note: Type.Optional(NoteSchema),
  },
  { additionalProperties: false, minProperties: 1 },
);
const addValidator = Compile(AddBodySchema);
const updateValidator = Compile(UpdateBodySchema);

function parseSetName(value: string): string {
  const trimmed = value.trim();
  const name = SET_LINK.exec(trimmed)?.[1] ?? trimmed;
  if (!SET_NAME.test(name)) {
    throw new AdminQueryError(
      'invalid_sticker_set_name',
      'name must be a Telegram sticker set name (letters, digits and underscores) or its t.me/addstickers link',
    );
  }
  return name;
}

/** A blank note means "no note"; the stored note is always trimmed. */
function parseNote(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length > STICKER_SET_NOTE_MAX_LENGTH) {
    throw new AdminQueryError('invalid_note', `note must be at most ${STICKER_SET_NOTE_MAX_LENGTH} characters`);
  }
  return trimmed.length === 0 ? undefined : trimmed;
}

function entry(alias: string, name: string, note: string | undefined): StickerSetEntry {
  return note === undefined ? { alias, name } : { alias, name, note };
}

/**
 * Telegram → Sticker sets. The list is `telegram.sticker_sets`; every write
 * goes through the reloader like the other configuration writes and is
 * hot-applied: the publish hook reconciles the store, fetches added sets and,
 * when a set is added or removed, stops running Telegram invocations.
 *
 * A set's Telegram name is its identity and cannot be edited; only the alias
 * (a nickname) and the note change. Pointing an alias at another set is a
 * removal plus an addition.
 */
export function createStickerSetsAdminHandler(deps: StickerSetsAdminDeps) {
  const { orm, configReloader, secrets } = deps;

  const view = async (): Promise<Response> => {
    // The list is the store's, so it renders even when the file cannot be
    // read; without a revision the panel only disables editing.
    let revision: string | null = null;
    if (configReloader !== undefined) {
      try {
        revision = (await readConfigFile(configReloader, secrets)).revision;
      } catch {
        revision = null;
      }
    }
    return json({ items: listStickerSets(orm), revision });
  };

  const write = async (
    request: Request,
    change: (current: readonly StickerSetEntry[]) => Promise<readonly StickerSetEntry[] | undefined>,
  ): Promise<Response> => {
    const reloader = configReloader;
    if (reloader === undefined) {
      return json({ error: 'sticker_sets_unavailable', message: 'Configuration reloading is not wired' }, 503);
    }
    const revision = requiredRevision(request);
    if (revision === null) {
      return revisionRequired();
    }
    const { loaded, revision: currentRevision } = await readConfigFile(reloader, secrets);
    if (revision !== currentRevision) {
      return json({ error: 'config_conflict', message: 'The configuration file changed; reload before editing' }, 409);
    }
    const next = await change(loaded.fileConfig.telegram?.sticker_sets ?? []);
    if (next === undefined) {
      // Nothing changed; an identical edit would fail the write.
      return json({
        items: listStickerSets(orm),
        revision: currentRevision,
        apply: { applied: [], restart_required: [], outside_serve: [] },
      });
    }
    const result = await reloader.writeAndApply(
      [{ path: ['telegram', 'sticker_sets'], value: next.length === 0 ? undefined : next }],
      revision,
    );
    if (!result.ok) {
      const message = result.fileWritten
        ? `config.jsonc was updated but not applied: ${result.message}`
        : result.message;
      return json({ error: result.code, message: redact(secrets, message) }, CONFIG_WRITE_STATUS[result.code] ?? 409);
    }
    const after = await readConfigFile(reloader, secrets);
    return json({
      items: listStickerSets(orm),
      revision: after.revision,
      apply: { applied: result.applied, restart_required: result.restartRequired, outside_serve: result.outsideServe },
    });
  };

  const add = (request: Request): Promise<Response> =>
    write(request, async (current) => {
      const body: unknown = await readJsonObject(request);
      if (!addValidator.Check(body)) {
        throw new AdminQueryError(
          'invalid_body',
          'Expected { name, alias, note? }: alias starts with a letter and uses letters, digits, "_" or "-" (at most 64)',
        );
      }
      const name = parseSetName(body.name);
      const note = parseNote(body.note);
      if (current.some((set) => set.name.toLowerCase() === name.toLowerCase())) {
        throw new AdminQueryError('sticker_set_exists', `Sticker set ${name} is already configured`, 409);
      }
      if (current.some((set) => set.alias === body.alias)) {
        throw new AdminQueryError('sticker_set_alias_taken', `Alias ${body.alias} is already used`, 409);
      }
      return [...current, entry(body.alias, name, note)];
    });

  const update = (request: Request, alias: string): Promise<Response> =>
    write(request, async (current) => {
      const raw = await readJsonObject(request);
      if (Object.hasOwn(raw, 'name')) {
        throw new AdminQueryError(
          'sticker_set_name_immutable',
          'A sticker set keeps the Telegram set it was added with; remove it and add the other set instead',
        );
      }
      const body: unknown = raw;
      if (!updateValidator.Check(body)) {
        throw new AdminQueryError(
          'invalid_body',
          'Expected { alias?, note? } with at least one field; note null or blank removes the note',
        );
      }
      const index = current.findIndex((set) => set.alias === alias);
      const existing = current[index];
      if (existing === undefined) {
        throw new AdminQueryError('not_found', 'No configured sticker set has this alias', 404);
      }
      const nextAlias = body.alias ?? existing.alias;
      const nextNote = Object.hasOwn(body, 'note') ? parseNote(body.note) : existing.note;
      if (nextAlias !== existing.alias && current.some((set) => set.alias === nextAlias)) {
        throw new AdminQueryError('sticker_set_alias_taken', `Alias ${nextAlias} is already used`, 409);
      }
      if (nextAlias === existing.alias && nextNote === existing.note) {
        return undefined;
      }
      return current.map((set, position) => (position === index ? entry(nextAlias, existing.name, nextNote) : set));
    });

  const remove = (request: Request, alias: string): Promise<Response> =>
    write(request, async (current) => {
      if (!current.some((set) => set.alias === alias)) {
        throw new AdminQueryError('not_found', 'No configured sticker set has this alias', 404);
      }
      return current.filter((set) => set.alias !== alias);
    });

  return {
    async handle(request: Request, segments: readonly string[]): Promise<Response | undefined> {
      if (segments[0] !== 'sticker-sets') {
        return undefined;
      }
      if (segments.length === 1) {
        if (request.method === 'GET') {
          return await view();
        }
        return request.method === 'POST' ? await add(request) : undefined;
      }
      const decoded = segments.length === 2 ? decodeSegments(segments) : null;
      const alias = decoded?.[1];
      if (alias === undefined) {
        return undefined;
      }
      if (request.method === 'PUT') {
        return await update(request, alias);
      }
      return request.method === 'DELETE' ? await remove(request, alias) : undefined;
    },
  };
}
