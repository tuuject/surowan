import { setImmediate } from 'node:timers/promises';
import { and, asc, desc, gt, isNotNull, lte, or } from 'drizzle-orm';
import Type from 'typebox';
import Compile from 'typebox/compile';
import { modelCalls } from '../../store/schema/index.ts';
import type { Orm } from '../../store/store.ts';
import type { ConfigEdit } from '../../platform/config/write.ts';
import { AdminQueryError } from './audit/shared.ts';

const settingsValidator = Compile(
  Type.Object(
    {
      record_model_payloads: Type.Optional(Type.Boolean()),
      record_agent_thinking: Type.Optional(Type.Boolean()),
      models_dev_url: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 2048 }), Type.Null()])),
    },
    { additionalProperties: false },
  ),
);

export interface DeveloperBody {
  readonly record_model_payloads?: boolean;
  readonly record_agent_thinking?: boolean;
  /** `null` removes the setting, so lookups fall back to models.dev. */
  readonly models_dev_url?: string | null;
}

export function parseDeveloperSettings(value: unknown): DeveloperBody {
  if (!settingsValidator.Check(value)) {
    throw new AdminQueryError(
      'invalid_body',
      'record_model_payloads and record_agent_thinking must be booleans; models_dev_url a URL string or null',
    );
  }
  if (
    value.record_model_payloads === undefined &&
    value.record_agent_thinking === undefined &&
    value.models_dev_url === undefined
  ) {
    throw new AdminQueryError('invalid_body', 'Provide record_model_payloads, record_agent_thinking or models_dev_url');
  }
  return value;
}

/**
 * The edit for the catalog address. The section has no other field, so
 * clearing the address removes the section instead of leaving `{}` behind.
 */
export function modelsDevUrlEdit(url: string | null): ConfigEdit {
  return url === null
    ? { path: ['models_dev'], value: undefined }
    : { path: ['models_dev', 'api_url'], value: url.trim() };
}

export async function clearModelPayloads(orm: Orm): Promise<number> {
  // Bound the sweep to existing calls; ongoing recording must not keep it alive forever.
  const upper = orm.select({ id: modelCalls.id }).from(modelCalls).orderBy(desc(modelCalls.id)).limit(1).get()?.id;
  if (upper === undefined) {
    return 0;
  }
  let cursor = 0n;
  let cleared = 0;
  while (cursor < upper) {
    const batch = orm
      .select({ id: modelCalls.id })
      .from(modelCalls)
      .where(and(gt(modelCalls.id, cursor), lte(modelCalls.id, upper)))
      .orderBy(asc(modelCalls.id))
      .limit(100)
      .all();
    const last = batch.at(-1)?.id;
    if (last === undefined) {
      break;
    }
    const result = orm
      .update(modelCalls)
      .set({ requestJson: null, responseJson: null })
      .where(
        and(
          gt(modelCalls.id, cursor),
          lte(modelCalls.id, last),
          or(isNotNull(modelCalls.requestJson), isNotNull(modelCalls.responseJson)),
        ),
      )
      .run();
    cleared += result.changes;
    cursor = last;
    // SQLite is synchronous: release the write lock and let the Bot run between batches.
    await setImmediate();
  }
  return cleared;
}
