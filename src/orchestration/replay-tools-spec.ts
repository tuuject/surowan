/**
 * Shared replay tool spec: the current-schema input guards, the replay-only
 * constants, and the projection of one registry definition onto an agent tool.
 *
 * Split out of `replay-tools.ts` so both replay tool modules can use it
 * without importing the registry itself; it stays free of store and runtime
 * wiring.
 */

import Type, { type TSchema } from 'typebox';
import Compile from 'typebox/compile';
import { SendInputSchema, SendReplyInputSchema } from '../capabilities/send-tool.ts';
import { AddMemoryInputSchema, DeleteMemoryInputSchema } from '../context/memory.ts';
import { AlarmInputSchema, DeleteAlarmInputSchema, ListAlarmInputSchema } from '../plugins/alarm/alarm.ts';
import { ImageGenerateInputSchema, ListImageModelsInputSchema } from '../plugins/image/image.ts';
import type { ReplayToolDefinition } from './replay-tools.ts';

/** Current-schema guards: model-facing schemas come from the active tool registry. */
export const SendInputValidator = Compile(SendInputSchema);
export const SendReplyInputValidator = Compile(SendReplyInputSchema);
export const AddMemoryInputValidator = Compile(AddMemoryInputSchema);
export const DeleteMemoryInputValidator = Compile(DeleteMemoryInputSchema);
export const AlarmInputValidator = Compile(AlarmInputSchema);
export const ListAlarmInputValidator = Compile(ListAlarmInputSchema);
export const DeleteAlarmInputValidator = Compile(DeleteAlarmInputSchema);
export const ImageGenerateInputValidator = Compile(ImageGenerateInputSchema);
export const ListImageModelsInputValidator = Compile(ListImageModelsInputSchema);
export const ZzzInputValidator = Compile(Type.Object({}, { additionalProperties: false }));
/**
 * Mirrors the current ReadInputSchema, which is module-private in
 * `capabilities/read-tool.ts`; the real path check is `SystemResources.resolve`.
 */
export const ReplayReadInputValidator = Compile(
  Type.Object(
    {
      uri: Type.String({ minLength: 1, maxLength: 512 }),
      base: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    },
    { additionalProperties: false },
  ),
);

/** Mirrors store/sleep.ts; replay never writes the sleep state. */
export const REPLAY_MINIMUM_SLEEP_MS = 8 * 60 * 60 * 1_000;
export const REPLAY_IMAGE_MODEL_ID = 'replay';
export const REPLAY_IMAGE_DEFAULT_OUTPUT_COUNT = 1;

/** Capabilities that have a real in-memory implementation; everything else is blocked. */
export const SYNTHETIC_CAPABILITIES: ReadonlySet<string> = new Set([
  'add_memory',
  'delete_memory',
  'alarm',
  'list_alarm',
  'delete_alarm',
  'image_generate',
  'list_image_models',
  'typing',
]);

/** The current registry supplies name, label, description, and parameters. */
export function replayToolBase(definition: ReplayToolDefinition): {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
} {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
  };
}
