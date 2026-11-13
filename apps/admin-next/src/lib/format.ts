import i18n from './i18n.ts';

/**
 * Status colours, read by `StateBadge`. As in the Koi admin template, a state
 * that ended normally stays neutral and only states that need a look get a
 * colour: in progress (primary), waiting or budget-limited (warning), failed
 * (error). A coloured "completed" would also blend with "failed" under the
 * rose palette.
 */
const STATE_COLORS: Record<string, string> = {
  completed: 'default',
  success: 'default',
  ready: 'default',
  running: 'blue',
  queued: 'geekblue',
  pending: 'gold',
  collecting: 'cyan',
  merged: 'default',
  failed: 'red',
  error: 'red',
  aborted: 'volcano',
  outcome_unknown: 'magenta',
  skipped_budget: 'orange',
  blocked_budget: 'orange',
  expired: 'default',
  firing: 'blue',
  fired: 'default',
  cancelled: 'default',
};

const TIME_FORMAT = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function formatTime(value: string | null): string {
  if (value === null || value.length === 0) {
    return '—';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : TIME_FORMAT.format(date);
}

/**
 * A time as the wall clock of `timeZone` reads it, with the weekday, the way a
 * schedule is planned (`Thu 2026-11-19 08:00`). Falls back to the panel's
 * local time when the zone is unknown.
 */
export function formatTimeInZone(value: string | null, timeZone: string): string {
  if (value === null || value.length === 0) {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  try {
    const weekday = new Intl.DateTimeFormat(i18n.language, { timeZone, weekday: 'short' }).format(date);
    const stamp = new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
    return `${weekday} ${stamp}`;
  } catch {
    return formatTime(value);
  }
}

export function formatNumber(value: number | null): string {
  return value === null ? '—' : value.toLocaleString(i18n.language);
}

export function formatCost(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(4)}`;
}

export function formatDuration(value: number | null): string {
  if (value === null) {
    return '—';
  }
  return value < 1_000 ? `${value} ms` : `${(value / 1_000).toFixed(2)} s`;
}

/** A state in the current language; a state the catalog doesn't know shows as itself. */
export function stateLabel(state: string): string {
  return i18n.t(`common.states.${state}` as 'common.states.queued', { defaultValue: state });
}

/** A message, media, send or reference kind in the current language, or the raw kind. */
export function kindLabel(kind: string): string {
  return i18n.t(`common.kinds.${kind}` as 'common.kinds.text', { defaultValue: kind });
}

/** A thinking effort level in the current language; `null` (no level) shows as a dash. */
export function thinkingLevelLabel(level: string | null): string {
  if (level === null) {
    return '—';
  }
  return i18n.t(`common.thinkingLevels.${level}` as 'common.thinkingLevels.off', { defaultValue: level });
}

/** The author of a model call, transcript entry or context message in the current language, or the raw role. */
export function roleLabel(role: string): string {
  return i18n.t(`common.roles.${role}` as 'common.roles.agent', { defaultValue: role });
}

export function stateColor(state: string): string {
  return STATE_COLORS[state] ?? 'default';
}

export function prettyJson(value: string | null): string | null {
  if (value === null || value.length === 0) {
    return null;
  }
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
