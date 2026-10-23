import { call, type Page } from './core.ts';

export type WarningSeverity = 'warning' | 'critical';

export type WarningCategory = 'developer' | 'models' | 'runtime' | 'security';

export interface WarningBase {
  readonly kind: 'standing' | 'event';
  readonly code: string;
  readonly category: WarningCategory;
  readonly severity: WarningSeverity;
  readonly variables: Readonly<Record<string, unknown>>;
}

export interface StandingWarning extends WarningBase {
  readonly kind: 'standing';
  readonly updated_at: string;
}

export interface EventWarning extends WarningBase {
  readonly kind: 'event';
  readonly id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly read_at: string | null;
}

export type WarningItem = StandingWarning | EventWarning;

export interface WarningsPage extends Page<EventWarning> {
  readonly generated_at: string;
  readonly standing: readonly StandingWarning[];
  readonly unread_count: number;
}

export interface WarningsListOptions {
  readonly limit: number;
  readonly cursor?: string | null;
  readonly unread?: boolean;
}

export function listWarnings(options: WarningsListOptions): Promise<WarningsPage> {
  const params = new URLSearchParams({ limit: String(options.limit) });
  if (options.cursor !== undefined && options.cursor !== null) {
    params.set('cursor', options.cursor);
  }
  if (options.unread === true) {
    params.set('unread', '1');
  }
  return call<WarningsPage>(`/warnings?${params.toString()}`);
}

export function markWarningRead(id: string): Promise<{ item: EventWarning }> {
  return call<{ item: EventWarning }>(`/warnings/${encodeURIComponent(id)}/read`, { method: 'POST' });
}

export function clearWarnings(): Promise<{ cleared: number }> {
  return call<{ cleared: number }>('/warnings', { method: 'DELETE' });
}
