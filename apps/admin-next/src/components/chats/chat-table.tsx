import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { type ColumnSpec, TableShell } from '@/components/business';
import { useChatFacts } from '@/components/chats/facts';
import {
  ChatActions,
  ChatIdentity,
  ChatModelSummary,
  ChatPolicySummary,
  type ChatRowHandlers,
  ChatSettingsDetails,
  ChatStatusBadge,
} from '@/components/chats/row-parts';
import type { ChatEntry, ChatsView } from '@/lib/api/chats.ts';
import type { DecisionGateView } from '@/lib/api/decision-gate.ts';

/**
 * Composite cells read top-down; centring them against a tall policy cell
 * scatters the row. The details toggle and the actions follow the first line.
 */
const tableClass = css({ '& > tbody > tr > td': { verticalAlign: 'top' } });
const topCell = css({ whiteSpace: 'normal' });

/**
 * The wide allowlist: five composite columns, so a row reads as one Chat
 * instead of a field per setting. The row's details open the full settings.
 */
export function ChatTable({
  view,
  items,
  gate,
  handlers,
}: {
  readonly view: ChatsView;
  readonly items: readonly ChatEntry[];
  /** The global entry gate; `undefined` while it is unknown. */
  readonly gate: DecisionGateView | undefined;
  readonly handlers: ChatRowHandlers;
}): ReactElement {
  const { t } = useTranslation();
  const facts = useChatFacts(view, gate);
  const columns: readonly ColumnSpec<ChatEntry>[] = [
    {
      key: 'chat',
      title: t('pages.chats.colChat'),
      width: '20%',
      className: topCell,
      render: (row) => <ChatIdentity row={row} facts={facts} />,
    },
    {
      key: 'model',
      title: t('pages.chats.colAgentModel'),
      width: '19%',
      className: topCell,
      render: (row) => <ChatModelSummary row={row} facts={facts} />,
    },
    {
      key: 'policy',
      title: t('pages.chats.colPolicy'),
      // The widest column takes whatever the others leave.
      className: topCell,
      render: (row) => <ChatPolicySummary row={row} facts={facts} />,
    },
    {
      key: 'status',
      title: t('pages.chats.colStatus'),
      // "Active" is the common case; a rare pending label in a long language may wrap.
      width: 128,
      className: topCell,
      render: (row) => <ChatStatusBadge row={row} />,
    },
    {
      key: 'actions',
      title: t('pages.chats.colActions'),
      align: 'right',
      width: 96,
      paddingBlock: 'none',
      render: (row) => <ChatActions row={row} view={view} handlers={handlers} />,
    },
  ];
  return (
    <TableShell
      columns={columns}
      data={items}
      rowKey={(row) => row.id}
      expandedRender={(row) => <ChatSettingsDetails row={row} facts={facts} />}
      className={tableClass}
      emptyText={t('pages.chats.emptyChats')}
    />
  );
}
