import { Badge } from '@tuuject/koi-react/badge';
import { css } from '@tuuject/koi-react/styled-system/css';
import type React from 'react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { stateColor, stateLabel } from '@/lib/format';

/**
 * State badge: maps the Ant Design color names emitted by `stateColor`
 * (`lib/format.ts`) onto Koi badge tones. The state → colour table stays in
 * `lib/format.ts`; unknown states and unknown colours fall back to neutral.
 */

export type BadgeSemantic = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

const LEGACY_COLOR_TO_SEMANTIC: Record<string, BadgeSemantic> = {
  green: 'success',
  blue: 'info',
  geekblue: 'info',
  cyan: 'info',
  gold: 'warning',
  orange: 'warning',
  volcano: 'warning',
  red: 'danger',
  magenta: 'danger',
  purple: 'info',
  default: 'neutral',
};

/** Koi has primary / warning / error / neutral; success and info are both informational here. */
const KOI_TONE = {
  success: 'primary',
  info: 'primary',
  warning: 'warning',
  danger: 'error',
  neutral: 'neutral',
} as const;

export function stateBadgeSemantic(state: string): BadgeSemantic {
  return LEGACY_COLOR_TO_SEMANTIC[stateColor(state)] ?? 'neutral';
}

/** Pill badge in one of the semantic tones; colours come from Koi's token set only. */
export function ToneBadge({
  tone,
  children,
  className,
}: {
  readonly tone: BadgeSemantic;
  readonly children: React.ReactNode;
  readonly className?: string;
}): ReactElement {
  return (
    <Badge tone={KOI_TONE[tone]} {...(className === undefined ? {} : { className })}>
      {children}
    </Badge>
  );
}

export function StateBadge({
  state,
  className,
}: {
  readonly state: string | null;
  readonly className?: string;
}): ReactElement {
  // Subscribes the badge to language changes; the label itself comes from `stateLabel`.
  useTranslation();
  if (state === null || state.length === 0) {
    return <span className={css({ color: 'text-muted' })}>—</span>;
  }
  return (
    <ToneBadge tone={stateBadgeSemantic(state)} {...(className !== undefined ? { className } : {})}>
      {stateLabel(state)}
    </ToneBadge>
  );
}
