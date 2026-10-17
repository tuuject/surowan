import type { AgentTurnContext } from '@earendil-works/pi-agent-core';

/**
 * Turns in a row that may make the same failing tool calls before the run
 * stops. An unchanged call fails the same way again, so without this a model
 * that keeps retrying it burns every turn up to `turns_per_injection`.
 */
export const REPEATED_TOOL_FAILURE_TURNS = 3;

/** Counts consecutive turns whose tool calls all failed exactly like the previous turn's. */
export class RepeatedToolFailure {
  #signature: string | null = null;
  #turns = 0;

  /** Records a finished turn; true once the same failure has lasted the limit. */
  observe(turn: Pick<AgentTurnContext, 'message' | 'toolResults'>): boolean {
    const signature = failedTurnSignature(turn);
    if (signature === null) {
      this.reset();
      return false;
    }
    this.#turns = signature === this.#signature ? this.#turns + 1 : 1;
    this.#signature = signature;
    return this.#turns >= REPEATED_TOOL_FAILURE_TURNS;
  }

  /** New input can make the same call succeed, so it starts the count over. */
  reset(): void {
    this.#signature = null;
    this.#turns = 0;
  }
}

function failedTurnSignature(turn: Pick<AgentTurnContext, 'message' | 'toolResults'>): string | null {
  const calls = turn.message.content.filter((entry) => entry.type === 'toolCall');
  if (
    calls.length === 0 ||
    turn.toolResults.length !== calls.length ||
    turn.toolResults.some((result) => !result.isError)
  ) {
    return null;
  }
  return JSON.stringify([
    calls.map((call) => [call.name, call.arguments]),
    turn.toolResults.map((result) =>
      result.content.flatMap((entry) => (entry.type === 'text' ? [entry.text] : [])).join(''),
    ),
  ]);
}
