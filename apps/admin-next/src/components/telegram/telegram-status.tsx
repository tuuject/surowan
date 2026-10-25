import { useTranslation } from 'react-i18next';
import { ToneBadge } from '@/components/business';
import type { TelegramBot, TelegramConnectionState, TelegramConnectionStatus } from '@/lib/api/telegram.ts';

const STATUS_TONE: Record<TelegramConnectionStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  connected: 'success',
  network_error: 'warning',
  config_error: 'danger',
  disabled: 'neutral',
};

/** The status label is shared by the settings page and the overview card. */
export function TelegramStatusBadge({ state }: { readonly state: TelegramConnectionState }): React.ReactElement {
  const { t } = useTranslation();
  return <ToneBadge tone={STATUS_TONE[state.status]}>{t(`pages.telegram.status.${state.status}`)}</ToneBadge>;
}

/** A config error's reason is the actionable half; other states have no extra label. */
export function TelegramStatusReason({
  state,
}: {
  readonly state: TelegramConnectionState;
}): React.ReactElement | null {
  const { t } = useTranslation();
  if (state.status !== 'config_error') {
    return null;
  }
  return <span className="text-muted-foreground text-sm">{t(`pages.telegram.reason.${state.reason}`)}</span>;
}

/** `@name` when Telegram reported one, the numeric id while only that is known. */
export function telegramBotLabel(bot: TelegramBot): string {
  return bot.username === null ? bot.id : `@${bot.username}`;
}
