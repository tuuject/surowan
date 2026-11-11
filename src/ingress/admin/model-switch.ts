/**
 * A panel model switch stops the Invocations still running on the model being
 * replaced (`orchestration/model-switch.ts`). Stopping them drops the reply to
 * the batch they were working on, so the switch endpoints first refuse with
 * this code and the number of Invocations involved; the admin confirms by
 * sending the same request again with `abort_running: true`.
 */
export const MODEL_IN_USE = 'model_in_use';

/** The refusal a switch answers with while Invocations still run on the replaced model. */
export function modelInUseBody(count: number): {
  readonly error: string;
  readonly message: string;
  readonly running_invocations: number;
} {
  return {
    error: MODEL_IN_USE,
    message: `${count} running invocation(s) still use the current model; send abort_running: true to stop them and switch`,
    running_invocations: count,
  };
}
