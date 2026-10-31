import { useTranslation } from 'react-i18next';
import { ToneBadge } from '@/components/business';
import type { MemoryEntry } from '@/lib/api/memories.ts';

export const MEMORY_STATES = ['active', 'expired', 'short', 'long'] as const;

export const STATE_LABEL_KEYS = {
  active: 'pages.memories.filterActive',
  expired: 'pages.memories.filterExpired',
  short: 'pages.memories.filterShort',
  long: 'pages.memories.filterLong',
} as const satisfies Record<(typeof MEMORY_STATES)[number], string>;

export function MemoryStatus({ row }: { readonly row: MemoryEntry }): React.ReactElement {
  const { t } = useTranslation();
  if (row.expired) {
    return <ToneBadge tone="neutral">{t('pages.memories.expired')}</ToneBadge>;
  }
  return row.short_term ? (
    <ToneBadge tone="warning">{t('pages.memories.shortTerm')}</ToneBadge>
  ) : (
    <ToneBadge tone="info">{t('pages.memories.longTerm')}</ToneBadge>
  );
}
