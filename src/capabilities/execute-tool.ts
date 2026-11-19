import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import Type from 'typebox';
import Compile from 'typebox/compile';
import { type ToolImageReference, toolImageMarker, toolImageReferences } from '../platform/tool-images.ts';
import { searchQuery, searchScore } from '../platform/text-search.ts';
import { safeJson, truncateUtf8 } from '../platform/truncate.ts';
import type { ToolAudit } from '../store/tool-audit.ts';

const Strict = { additionalProperties: false } as const;
const ToolNamePattern = '^[A-Za-z0-9_-]{1,128}$';
const RESULT_MAX_BYTES = 32_768;
/** Leaves headroom for the envelope wrapper and refs inside RESULT_MAX_BYTES. */
const TEXT_MAX_BYTES = 30_720;
const INPUT_MAX_BYTES = 32_768;
const SEARCH_RESULT_LIMIT = 8;

/**
 * Provider-facing input contract. OpenAI-compatible endpoints reject a tool whose
 * `parameters` is not a root object schema: as a top-level union this one made
 * gpt-4o answer every request with 400 invalid_function_parameters, failing the
 * whole invocation. The actions therefore share one flattened object, and the
 * per-action requiredness a flat schema cannot express is enforced by
 * `parseExecuteRequest` before dispatch.
 */
const ExecuteInputSchema = Type.Object(
  {
    action: Type.Enum({ search: 'search', help: 'help', call: 'call' }),
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    tool: Type.Optional(Type.String({ pattern: ToolNamePattern })),
    input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  Strict,
);
const ExecuteInputValidator = Compile(ExecuteInputSchema);

/** One action of the flattened contract, with the fields that action requires. */
type ExecuteRequest =
  | { readonly action: 'search'; readonly query: string }
  | { readonly action: 'help'; readonly tool: string }
  | { readonly action: 'call'; readonly tool: string; readonly input: Record<string, unknown> };

/** Runtime primitives are registered by the runtime itself and never callable through execute. */
export const EXECUTE_PRIMITIVES: ReadonlySet<string> = new Set([
  'read',
  'send',
  'send_reply',
  'execute',
  'zzz',
  'search_memory',
  'read_memory',
  'read_member_profile',
  'mcp',
]);
const SIDE_EFFECTING_PRIMITIVES: ReadonlySet<string> = new Set(['send', 'send_reply', 'zzz']);

export interface CapabilityToolDetails {
  readonly refs?: Readonly<Record<string, readonly string[]>>;
}

export interface ExecuteToolDetails {
  readonly action: 'search' | 'help' | 'call';
  readonly tool?: string;
  readonly matches?: number;
  readonly refs?: Readonly<Record<string, readonly string[]>>;
  readonly toolImages?: { readonly version: 1; readonly items: readonly ToolImageReference[] };
}

export interface ExecutableCapability {
  readonly tool: AgentTool;
  readonly sideEffect: boolean;
  readonly inputMaxBytes?: number;
}

/** Wraps one runtime-internal tool as an execute-registry entry. */
export function capability(
  tool: AgentTool,
  sideEffect: boolean,
  options: { readonly inputMaxBytes?: number } = {},
): ExecutableCapability {
  return { tool, sideEffect, ...options };
}

export interface ExecuteToolOptions {
  readonly audit: ToolAudit;
  readonly capabilities: readonly ExecutableCapability[];
}

interface RegisteredCapability {
  readonly entry: ExecutableCapability;
  readonly validator: { Check(value: unknown): boolean };
}

/**
 * The `execute` runtime primitive: a controlled dispatch interface between
 * the model and runtime-internal capabilities. It does discovery, help,
 * validation, dispatch, and auditing — never reasoning on the model's behalf,
 * and never exposing the read/send/send_reply/execute/zzz primitives or MCP tools.
 */
export function createExecuteTool(
  options: ExecuteToolOptions,
): AgentTool<typeof ExecuteInputSchema, ExecuteToolDetails> {
  const registered = new Map<string, RegisteredCapability>();
  for (const entry of options.capabilities) {
    if (EXECUTE_PRIMITIVES.has(entry.tool.name)) {
      throw new Error(`Runtime primitive ${entry.tool.name} cannot be registered as an execute capability`);
    }
    if (registered.has(entry.tool.name)) {
      throw new Error(`Duplicate execute capability name: ${entry.tool.name}`);
    }
    registered.set(entry.tool.name, { entry, validator: Compile(entry.tool.parameters) });
  }
  return {
    name: 'execute',
    label: 'Call a runtime capability',
    description:
      'Controlled gateway to runtime-internal capabilities (web fetching, sticker search, image analysis, memory notes, alarms). Actions: search finds capabilities for a need, e.g. query "fetch a web page", and returns [{name, summary}]; help returns one capability\'s full description and parameters; call invokes one capability with a JSON object input. After deciding to reply, you MAY call typing with input:{} before slow work such as search; quick replies SHOULD go directly to send, and silence needs no typing. The runtime refreshes and clears typing automatically. You SHOULD prefer the system skill index and skill documents for how to use a capability; use search only when no skill covers the need, and check help when unsure about the input contract. call returns an envelope {text, refs}: text is bounded evidence or structured data, refs holds conversation-scoped reference tokens (such as sticker_ref) that only their named consumer tool accepts after validation; a capability that returns a picture (such as web_fetch on an image URL) attaches it after the envelope. A ref stays valid in this conversation for a limited time, so one returned earlier in the retained history MAY be reused while it still resolves instead of repeating the call — you MUST NOT guess or fabricate them. The directly exposed tools (read, send, send_reply, execute, zzz) and MCP tools MUST NOT be called through execute. On failure, you MUST NOT invent results and MUST NOT blindly retry side effects.',
    parameters: ExecuteInputSchema,
    executionMode: 'sequential',
    execute: async (toolCallId, input, signal) => {
      const parsed = parseExecuteRequest(input);
      if ('error' in parsed) {
        rejectExecute(options, toolCallId, input, 'invalid_arguments');
        throw new Error(parsed.error);
      }
      const request = parsed.request;
      if (request.action === 'search') {
        return executeSearch(options, registered, toolCallId, request.query);
      }
      if (request.action === 'help') {
        return executeHelp(options, registered, toolCallId, request.tool);
      }
      return executeCall(options, registered, toolCallId, request.tool, request.input, signal);
    },
  };
}

/**
 * Restores the per-action contract of the flattened provider input: the schema
 * cannot require `query` for search alone or `tool` for help and call alone, and
 * a lenient endpoint may hand over input the schema forbids.
 */
function parseExecuteRequest(input: unknown): { readonly request: ExecuteRequest } | { readonly error: string } {
  if (!ExecuteInputValidator.Check(input)) {
    return { error: 'execute input does not match the tool schema' };
  }
  if (input.action === 'search') {
    return input.query === undefined
      ? { error: 'execute.search requires a query string' }
      : { request: { action: 'search', query: input.query } };
  }
  if (input.tool === undefined) {
    return { error: `execute.${input.action} requires a capability name` };
  }
  if (input.action === 'help') {
    return { request: { action: 'help', tool: input.tool } };
  }
  return input.input === undefined
    ? { error: 'execute.call requires an input object' }
    : { request: { action: 'call', tool: input.tool, input: input.input } };
}

function executeSearch(
  options: ExecuteToolOptions,
  registered: Map<string, RegisteredCapability>,
  toolCallId: string,
  query: string,
): AgentToolResult<ExecuteToolDetails> {
  const audit = options.audit.start(toolCallId, 'execute', JSON.stringify({ action: 'search', query }), false);
  const results = searchCapabilities([...registered.values()], query);
  const text = JSON.stringify(results);
  audit.succeed(text);
  return {
    content: [{ type: 'text' as const, text }],
    details: { action: 'search', matches: results.length },
  };
}

function executeHelp(
  options: ExecuteToolOptions,
  registered: Map<string, RegisteredCapability>,
  toolCallId: string,
  toolName: string,
): AgentToolResult<ExecuteToolDetails> {
  const target = registered.get(toolName);
  if (target === undefined) {
    rejectExecute(options, toolCallId, { action: 'help', tool: toolName }, unknownCapabilityCode(toolName));
    throw new Error(unknownCapabilityMessage(toolName));
  }
  const audit = options.audit.start(toolCallId, 'execute', JSON.stringify({ action: 'help', tool: toolName }), false);
  const payload = {
    name: target.entry.tool.name,
    label: target.entry.tool.label,
    description: target.entry.tool.description,
    parameters: target.entry.tool.parameters,
  };
  const text = truncateUtf8(JSON.stringify(payload), RESULT_MAX_BYTES);
  audit.succeed(text);
  return {
    content: [{ type: 'text' as const, text }],
    details: { action: 'help', tool: toolName },
  };
}

async function executeCall(
  options: ExecuteToolOptions,
  registered: Map<string, RegisteredCapability>,
  toolCallId: string,
  toolName: string,
  callInput: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<ExecuteToolDetails>> {
  const argumentsJson = safeJson({ action: 'call', tool: toolName, input: callInput }, INPUT_MAX_BYTES);
  const target = registered.get(toolName);
  if (target === undefined) {
    rejectExecute(options, toolCallId, { action: 'call', tool: toolName }, unknownCapabilityCode(toolName));
    throw new Error(unknownCapabilityMessage(toolName));
  }
  const inputMaxBytes = target.entry.inputMaxBytes ?? INPUT_MAX_BYTES;
  if (
    Array.isArray(callInput) ||
    typeof callInput !== 'object' ||
    callInput === null ||
    Buffer.byteLength(JSON.stringify(callInput)) > inputMaxBytes
  ) {
    rejectExecute(options, toolCallId, { action: 'call', tool: toolName, input: callInput }, 'arguments_too_large');
    throw new Error(`execute.call input exceeds ${inputMaxBytes / 1_024} KiB`);
  }
  if (!target.validator.Check(callInput)) {
    rejectExecute(options, toolCallId, { action: 'call', tool: toolName, input: callInput }, 'invalid_arguments');
    throw new Error(`execute.call input does not match the schema of ${toolName}`);
  }
  const audit = options.audit.start(toolCallId, 'execute', argumentsJson, target.entry.sideEffect);
  try {
    // Capabilities are not required to honour the signal (alarm ignores it), so
    // a call queued before the run was cancelled must stop here, before any side
    // effect, and be audited as aborted.
    signal?.throwIfAborted();
    const result = await target.entry.tool.execute(`${toolCallId}:${toolName}`, callInput, signal);
    // Text payload: bounded and truncated. Reference payload: conversation-scoped
    // tokens from details.refs. Pictures: the runtime-minted tool images the
    // capability attached, carried as markers after the envelope so the
    // request-time projection attaches their pixels; bytes never enter history.
    const images = capabilityImages(result.content, result.details);
    const imagePositions = new Set(images.map((image) => image.contentIndex));
    const innerText = result.content
      .flatMap((entry, index) => (entry.type === 'text' && !imagePositions.has(index) ? [entry.text] : []))
      .join('\n');
    const refs = readCapabilityRefs(result.details);
    const envelope = JSON.stringify({
      text: truncateUtf8(innerText, TEXT_MAX_BYTES),
      ...(Object.keys(refs).length === 0 ? {} : { refs }),
    });
    const text = truncateUtf8(envelope, RESULT_MAX_BYTES);
    const content = [
      { type: 'text' as const, text },
      ...images.map((image) => ({ type: 'text' as const, text: toolImageMarker(image.assetId) })),
    ];
    const details: ExecuteToolDetails = {
      action: 'call',
      tool: toolName,
      ...(Object.keys(refs).length === 0 ? {} : { refs }),
      ...(images.length === 0
        ? {}
        : { toolImages: { version: 1, items: images.map((image, index) => ({ ...image, contentIndex: index + 1 })) } }),
    };
    audit.succeed(text, images.length === 0 ? undefined : { resultContentJson: JSON.stringify({ content, details }) });
    return { content, details };
  } catch (error) {
    const code = signal?.aborted === true ? 'aborted' : 'capability_error';
    audit.fail(code);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`execute.call ${toolName} failed: ${message}`);
  }
}

function rejectExecute(options: ExecuteToolOptions, toolCallId: string, input: unknown, errorCode: string): void {
  const toolName =
    typeof input === 'object' && input !== null && 'tool' in input && typeof input.tool === 'string' ? input.tool : '';
  options.audit.reject(
    toolCallId,
    'execute',
    safeJson(input, INPUT_MAX_BYTES),
    SIDE_EFFECTING_PRIMITIVES.has(toolName),
    errorCode,
  );
}

function unknownCapabilityCode(toolName: string): string {
  return EXECUTE_PRIMITIVES.has(toolName) ? 'execute_primitive_rejected' : 'unknown_capability';
}

function unknownCapabilityMessage(toolName: string): string {
  return EXECUTE_PRIMITIVES.has(toolName)
    ? `execute cannot dispatch the runtime primitive ${toolName}; call it directly`
    : `execute has no capability named ${toolName}`;
}

function readCapabilityRefs(details: unknown): Record<string, readonly string[]> {
  if (typeof details !== 'object' || details === null) {
    return {};
  }
  const refs = (details as CapabilityToolDetails).refs;
  if (refs === undefined || typeof refs !== 'object') {
    return {};
  }
  const result: Record<string, readonly string[]> = {};
  for (const [kind, tokens] of Object.entries(refs)) {
    if (Array.isArray(tokens) && tokens.every((token) => typeof token === 'string')) {
      result[kind] = tokens;
    }
  }
  return result;
}

/** The capability's tool images, each checked against the marker it left in its content. */
function capabilityImages(
  content: AgentToolResult<unknown>['content'],
  details: unknown,
): readonly ToolImageReference[] {
  const images = toolImageReferences(details);
  for (const image of images) {
    const block = content[image.contentIndex];
    if (block?.type !== 'text' || block.text !== toolImageMarker(image.assetId)) {
      throw new Error('Capability tool image does not match its content position');
    }
  }
  return images;
}

function searchCapabilities(
  capabilities: readonly RegisteredCapability[],
  query: string,
): { name: string; summary: string }[] {
  const prepared = searchQuery(query);
  if (prepared.phrase.length === 0) {
    return [];
  }
  const scored = capabilities.flatMap(({ entry }) => {
    const name = entry.tool.name;
    const score = searchScore(prepared, [
      [`${name} ${name.replaceAll('_', ' ')}`, 3],
      [entry.tool.label, 2],
      [entry.tool.description, 1],
    ]);
    return score === 0 ? [] : [{ name, summary: entry.tool.label, score }];
  });
  scored.sort((left, right) => right.score - left.score || (left.name < right.name ? -1 : 1));
  return scored.slice(0, SEARCH_RESULT_LIMIT).map(({ name, summary }) => ({ name, summary }));
}
