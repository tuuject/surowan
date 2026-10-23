import { call, writeHeaders } from './core.ts';
import type { ThinkingLevel } from './models.ts';
import type { ProviderWriteResponse } from './providers.ts';

// ---------------------------------------------------------------------------
// Tool model (system-wide auxiliary model, dictionaries' merge first user)
// ---------------------------------------------------------------------------
export interface ToolModelView {
  readonly provider: string | null;
  readonly model: string | null;
  readonly thinking_level: ThinkingLevel | null;
  /** True when nothing is configured and the global agent settings are in use. */
  readonly inherited: boolean;
}

/** The auxiliary model pick, or `{ inherit: true }` to fall back to the agent. */
export function putToolModel(
  body:
    | { readonly inherit: true }
    | { readonly provider: string; readonly model: string; readonly thinking_level: ThinkingLevel },
  revision: string,
): Promise<ProviderWriteResponse> {
  return call<ProviderWriteResponse>('/tool-model', {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(body),
  });
}
