/**
 * One Chat's MCP binding: which of the configured outbound servers — and which
 * of their tools — this Chat may call.
 *
 * The three file states are all expressible: no `mcp` field (inherit every
 * server), `[]` (no MCP at all) or an explicit binding list. The bindings are
 * the configuration's own `ChatMcpBindingSchema`, and the whole candidate file
 * passes `validateSemantics` before anything is written, so an unknown alias or
 * a tool the server does not expose is answered here, not by a failed apply.
 */
import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import { ChatMcpBindingSchema } from '../../platform/config/schema-sections.ts';
import type { FileChat, FileConfig } from '../../platform/config/index.ts';
import { validateSemantics } from '../../platform/config/semantics.ts';
import type { SearchProviderRule } from '../../platform/web-search.ts';
import type { ConfigEdit } from '../../platform/config/write.ts';
import { AdminQueryError } from './audit/shared.ts';
import { invalid } from './mcp-servers/shared.ts';

const ChatMcpBodySchema = Type.Union([
  Type.Object({ mode: Type.Literal('inherit') }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal('none') }, { additionalProperties: false }),
  Type.Object(
    { mode: Type.Literal('explicit'), bindings: Type.Array(ChatMcpBindingSchema, { minItems: 1, maxItems: 64 }) },
    { additionalProperties: false },
  ),
]);
const bodyValidator = Compile(ChatMcpBodySchema);

export type ChatMcpBody = Static<typeof ChatMcpBodySchema>;

export function parseChatMcpBody(value: unknown): ChatMcpBody {
  if (!bodyValidator.Check(value)) {
    throw new AdminQueryError(
      'invalid_body',
      'Expected { mode: "inherit" }, { mode: "none" } or { mode: "explicit", bindings: [{ server, tools?, tool_policies? }] }',
    );
  }
  return value;
}

/** `PUT /api/chats/:id/mcp` — replaces only this Chat's binding list. */
export function updateChatMcp(
  file: FileConfig,
  id: number,
  body: ChatMcpBody,
  /** The deployment's registered search providers, as `validateSemantics` needs them. */
  providers: readonly SearchProviderRule[],
): ConfigEdit[] {
  const chats = file.telegram?.chats ?? [];
  const index = chats.findIndex((chat) => chat.id === id);
  if (index < 0) {
    throw new AdminQueryError('chat_not_found', `Chat ${id} is not configured in the file`, 404);
  }
  const section = file.telegram;
  // A chat was found above, so the section exists; the guard keeps the type honest.
  if (section === undefined) {
    throw new AdminQueryError('chat_not_found', `Chat ${id} is not configured in the file`, 404);
  }
  const current = chats[index] as FileChat;
  const value =
    body.mode === 'inherit' ? undefined : body.mode === 'none' ? [] : body.bindings.map((binding) => ({ ...binding }));
  if (JSON.stringify(current.mcp) === JSON.stringify(value)) {
    return [];
  }
  // The whole candidate passes the file's own semantics: unknown server aliases,
  // tools outside a server's explicit list and policies for unselected tools
  // are all caught here with the rule's own message.
  const { mcp: _previous, ...rest } = current;
  const candidateChats = [...chats];
  candidateChats[index] = value === undefined ? rest : { ...rest, mcp: value };
  const candidate: FileConfig = { ...file, telegram: { ...section, chats: candidateChats } };
  try {
    validateSemantics(candidate, { searchProviders: providers });
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
  return [{ path: ['telegram', 'chats', index, 'mcp'], value }];
}
