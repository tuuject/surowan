/**
 * Why an operator-driven configuration cutover stopped a running Invocation.
 *
 * The scheduler aborts with a reason string, but a run always persists its own
 * terminal state (`aborted`), so the cause would be lost. The cutover writes it
 * to `invocations.abort_cause` instead, and the continuation it queues reads it
 * back to explain its opening batch. Everything here is runtime-owned: the
 * codes are constants and the tool names come from the resolved MCP registry,
 * never from a model turn or Telegram content.
 */

/** The operator changed what this Chat's MCP servers expose; the run was stopped to swap them. */
export const MCP_CONFIG_CHANGED_ABORT_CAUSE = 'mcp_config_changed';

/** A runtime-written code; anything else is not echoed into a trusted prompt line. */
const ABORT_CAUSE_PATTERN = /^[a-z0-9_]{1,64}$/;
/** An exposed MCP tool name: the server alias and the tool's own name, joined by `__`. */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** The code stored in `invocations.abort_cause`, or undefined for anything unrecognized. */
export function readAbortCause(value: string | null): string | undefined {
  return value !== null && ABORT_CAUSE_PATTERN.test(value) ? value : undefined;
}

/**
 * The tool names stored in `invocations.abort_unknown_tools`. The column is a
 * runtime-written JSON array; an unreadable value reads as "nothing known"
 * instead of reaching the prompt.
 */
export function readAbortUnknownTools(value: string | null): string[] {
  if (value === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((name): name is string => typeof name === 'string' && TOOL_NAME_PATTERN.test(name))
      : [];
  } catch {
    return [];
  }
}

/** Encodes the names for `invocations.abort_unknown_tools`; only valid names survive. */
export function encodeAbortUnknownTools(names: readonly string[]): string {
  return JSON.stringify(names.filter((name) => TOOL_NAME_PATTERN.test(name)));
}
