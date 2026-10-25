/**
 * Shared fixtures and helpers for the replay-tool suites.
 *
 * These helpers build tool definitions and read arguments/results the way the
 * production replay bridge does, so each `replay-tools*.test.ts` file can focus
 * on one topic without copying the same scaffolding.
 *
 * This is not a test file: it is imported by the `replay-tools*.test.ts` suites.
 */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import Type, { type TSchema } from 'typebox';
import type { ReplayToolDefinition, ReplayToolRegistry, ReplayTools } from '../../src/orchestration/replay/tools.ts';

const EMPTY_PARAMETERS = Type.Object({}, { additionalProperties: false });

/** Parameters of the `read` runtime primitive the replay exposes. */
export const ReadParameters = Type.Object(
  { uri: Type.String(), base: Type.Optional(Type.String()) },
  { additionalProperties: false },
);

export function definition(name: string, parameters: TSchema = EMPTY_PARAMETERS): ReplayToolDefinition {
  return {
    name,
    label: name,
    description: `${name} current definition`,
    parameters,
  };
}

export function replayInput(options: {
  tools?: ReplayToolDefinition[];
  capabilities?: ReplayToolDefinition[];
}): ReplayToolRegistry {
  return { tools: options.tools ?? [], capabilities: options.capabilities ?? [] };
}

export function toolOf(tools: readonly AgentTool[], name: string): AgentTool {
  const found = tools.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`No replay tool named ${name}`);
  }
  return found;
}

export function textOf(result: AgentToolResult<unknown>): string {
  return result.content.flatMap((entry) => (entry.type === 'text' ? [entry.text] : [])).join('\n');
}

export function envelopeOf(result: AgentToolResult<unknown>): { text: string; refs?: Record<string, string[]> } {
  return JSON.parse(textOf(result)) as { text: string; refs?: Record<string, string[]> };
}

export function callCapability(
  replay: ReplayTools,
  toolCallId: string,
  name: string,
  input: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  return toolOf(replay.tools, 'execute').execute(toolCallId, { action: 'call', tool: name, input }) as Promise<
    AgentToolResult<unknown>
  >;
}
