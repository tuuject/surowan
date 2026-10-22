import type Database from 'better-sqlite3';
import { writeFile } from 'node:fs/promises';
import { field } from './support.ts';

export async function runPrompt(database: Database.Database, id: number, out: string | null): Promise<string> {
  const row = database
    .prepare<[number], { id: number; request_json: string | null }>(
      `SELECT id, request_json FROM model_calls
       WHERE invocation_id = ? AND request_json IS NOT NULL ORDER BY id DESC LIMIT 1`,
    )
    .get(id);
  if (row?.request_json === null || row === undefined) {
    throw new Error(`Invocation ${id} has no recorded model request`);
  }
  const parsed: unknown = JSON.parse(row.request_json);
  const request = parsed as {
    readonly messages?: readonly { readonly role?: unknown; readonly content?: unknown }[];
    readonly tools?: readonly {
      readonly function?: { readonly name?: unknown } | undefined;
      readonly name?: unknown;
    }[];
  };
  const system = request.messages?.find((message) => message.role === 'system');
  const systemText = typeof system?.content === 'string' ? system.content : '';
  if (systemText.length === 0) {
    throw new Error(`Invocation ${id}: the recorded request has no string system message`);
  }
  const tools = (request.tools ?? [])
    .map((tool) => field(tool.function?.name ?? tool.name))
    .filter((name) => name.length > 0);
  const header = `# invocation ${id}, model_call ${row.id}, ${systemText.length} characters, ${tools.length} tools\n# tools: ${tools.join(', ')}\n`;
  if (out !== null) {
    await writeFile(out, `${header}${systemText}\n`, 'utf8');
    return `wrote ${systemText.length} characters of system prompt to ${out} (${tools.length} tools)`;
  }
  return `${header}\n${systemText}`;
}
