import { call, writeHeaders } from './core.ts';

export type TelegramConnectionStatus = 'disabled' | 'connected' | 'network_error' | 'config_error';

export type TelegramConfigError = 'unauthorized' | 'conflict' | 'token_unreadable';

export interface TelegramBot {
  readonly id: string;
  readonly username: string | null;
}

/** Mirrors the backend `ImConnectionState`; `bot` can survive later failures. */
export type TelegramConnectionState =
  | { readonly status: 'disabled'; readonly since: string; readonly bot?: TelegramBot }
  | { readonly status: 'connected'; readonly since: string; readonly bot: TelegramBot }
  | { readonly status: 'network_error'; readonly since: string; readonly bot?: TelegramBot }
  | {
      readonly status: 'config_error';
      readonly since: string;
      readonly reason: TelegramConfigError;
      readonly bot?: TelegramBot;
    };

export interface TelegramView {
  readonly revision: string;
  readonly status: TelegramConnectionState;
  readonly telegram_section_present: boolean;
  readonly token_configured: boolean;
}

export interface TelegramApplySummary {
  readonly applied: readonly string[];
  readonly restart_required: readonly string[];
  readonly outside_serve: readonly string[];
}

export type TelegramUpdateResponse = TelegramView & { readonly apply: TelegramApplySummary };

export function getTelegram(): Promise<TelegramView> {
  return call<TelegramView>('/telegram');
}

/** `null` clears the token; the endpoint never deletes the whole `telegram` section. */
export function putTelegram(token: string | null, revision: string): Promise<TelegramUpdateResponse> {
  return call<TelegramUpdateResponse>('/telegram', {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify({ token }),
  });
}
