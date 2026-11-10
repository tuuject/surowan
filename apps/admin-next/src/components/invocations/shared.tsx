import { Link } from '@tanstack/react-router';
import { Empty } from '@tuuject/koi-react/empty';
import type React from 'react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { type BadgeSemantic, ToneBadge } from '@/components/business';
import type { InvocationChatSummary } from '@/lib/api/invocations.ts';
import { isNewContextSection } from '@/lib/timeline';

const ROLE_BADGE_TONES: Record<string, BadgeSemantic> = {
  assistant: 'warning',
  tool_result: 'info',
};

export function RoleBadge({ role }: { readonly role: string }): ReactElement {
  return <ToneBadge tone={ROLE_BADGE_TONES[role] ?? 'neutral'}>{role}</ToneBadge>;
}

export function SectionBadge({ section }: { readonly section: string }): ReactElement {
  const { t } = useTranslation();
  const isNew = isNewContextSection(section);
  return (
    <ToneBadge tone={isNew ? 'info' : 'neutral'}>
      {isNew ? t('invocations.invocationDetail.section.incoming') : t('invocations.invocationDetail.section.history')}
    </ToneBadge>
  );
}

export function isRoom(chat: InvocationChatSummary): boolean {
  return chat.host_kind === 'playground';
}

/**
 * A Telegram message has its own audit record; a room message lives in its
 * room, which is where the link goes instead.
 */
export function MessageRecordLink({
  chat,
  messageId,
  className,
  children,
}: {
  readonly chat: InvocationChatSummary;
  readonly messageId: string;
  readonly className: string;
  readonly children: React.ReactNode;
}): ReactElement {
  if (chat.room_id !== null) {
    return (
      <Link to="/playground" search={{ room: chat.room_id }} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <Link to="/messages/$messageId" params={{ messageId }} className={className}>
      {children}
    </Link>
  );
}

export function YesNoBadge({ value }: { readonly value: boolean }): ReactElement {
  const { t } = useTranslation();
  return value ? (
    <ToneBadge tone="warning">{t('invocations.messageDetail.yes')}</ToneBadge>
  ) : (
    <ToneBadge tone="neutral">{t('invocations.messageDetail.no')}</ToneBadge>
  );
}

export function TabEmpty({ message }: { readonly message: string }): ReactElement {
  const { t } = useTranslation();
  return <Empty variant="plain" title={t('invocations.invocationDetail.nothingHere')} description={message} />;
}

export function TabContent({
  count,
  message,
  children,
}: {
  readonly count: number;
  readonly message: string;
  readonly children: React.ReactNode;
}): React.ReactNode {
  if (count === 0) {
    return <TabEmpty message={message} />;
  }
  return <>{children}</>;
}
