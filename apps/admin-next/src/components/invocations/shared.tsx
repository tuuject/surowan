import { Link } from '@tanstack/react-router';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { type BadgeSemantic, ToneBadge } from '@/components/business';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';

import { isNewContextSection } from '@/lib/timeline';
import type { InvocationChatSummary } from '@/lib/api/invocations.ts';

const ROLE_BADGE_TONES: Record<string, BadgeSemantic> = {
  assistant: 'warning',
  tool_result: 'info',
};

export function RoleBadge({ role }: { readonly role: string }): React.ReactElement {
  return <ToneBadge tone={ROLE_BADGE_TONES[role] ?? 'neutral'}>{role}</ToneBadge>;
}

export function SectionBadge({ section }: { readonly section: string }): React.ReactElement {
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
}): React.ReactElement {
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

export function YesNoBadge({ value }: { readonly value: boolean }): React.ReactElement {
  const { t } = useTranslation();
  return value ? (
    <ToneBadge tone="warning">{t('invocations.messageDetail.yes')}</ToneBadge>
  ) : (
    <ToneBadge tone="neutral">{t('invocations.messageDetail.no')}</ToneBadge>
  );
}

export function TabEmpty({ message }: { readonly message: string }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{t('invocations.invocationDetail.nothingHere')}</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
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
