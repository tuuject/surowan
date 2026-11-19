import type { GenerationStatus } from '@surowan/image-service';

/** Shared constants of the bridge's submission and reconciliation halves. */

/** Outstanding generations per conversation per invocation, matching alarm's quota style. */
export const MAX_PER_INVOCATION = 3;

export const RECEIPT_PROMPT_PREVIEW_LENGTH = 200;

/** Receipt payload; snake_case matches the tool surface the model already sees. */
export interface SendableOutput {
  readonly asset_id: string;
  readonly file_name: string;
  readonly mime: string;
}

export interface GenerationDelivery {
  readonly generation_id: string;
  readonly status: GenerationStatus;
  readonly model_id: string;
  readonly prompt_preview: string;
  readonly outputs: readonly SendableOutput[];
  readonly error: string | null;
}
