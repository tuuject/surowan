import { Button } from '@tuuject/koi-react/button';
import { ChevronDownIcon } from '@tuuject/koi-react/icons';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type ChatFacts, useChatFacts } from '@/components/chats/facts';
import {
  ChatActions,
  ChatIdentity,
  ChatModelSummary,
  type ChatRowHandlers,
  ChatSettingsDetails,
  ChatStatusBadge,
  compactPolicyRows,
  FactRows,
  PolicyRunningNote,
} from '@/components/chats/row-parts';
import type { ChatEntry, ChatsView } from '@/lib/api/chats.ts';
import type { DecisionGateView } from '@/lib/api/decision-gate.ts';

/**
 * The allowlist where a table would not fit: one block per Chat, split by
 * hairlines like table rows. The same summary as the table's cells, with the
 * model as the first line, and the full settings one toggle away.
 */
export function ChatCardList({
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
  if (items.length === 0) {
    return (
      <p
        className={css({
          margin: '0',
          paddingBlock: '4',
          color: 'text-muted',
          borderBlockEnd: '1px solid',
          borderColor: 'divider',
        })}
      >
        {t('pages.chats.emptyChats')}
      </p>
    );
  }
  return (
    <ul className={css({ listStyle: 'none', margin: '0', padding: '0' })}>
      {items.map((row) => (
        <ChatCard key={row.id} row={row} view={view} facts={facts} handlers={handlers} />
      ))}
    </ul>
  );
}

function ChatCard({
  row,
  view,
  facts,
  handlers,
}: {
  readonly row: ChatEntry;
  readonly view: ChatsView;
  readonly facts: ChatFacts;
  readonly handlers: ChatRowHandlers;
}): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  return (
    <li
      data-chat-card=""
      className={css({
        display: 'flex',
        flexDirection: 'column',
        gap: '3',
        paddingBlock: '4',
        borderBlockEnd: '1px solid',
        borderColor: 'divider',
      })}
    >
      <div className={css({ display: 'flex', alignItems: 'flex-start', gap: '3' })}>
        <div className={css({ flex: '1', minWidth: '0' })}>
          <ChatIdentity row={row} facts={facts} status={<ChatStatusBadge row={row} />} />
        </div>
        <ChatActions row={row} view={view} handlers={handlers} inset />
      </div>
      <div className={css({ minWidth: '0', '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
        <FactRows
          labels={[t('pages.chats.colAgentModel'), ...facts.compactLabels]}
          rows={[
            {
              key: 'model',
              label: t('pages.chats.colAgentModel'),
              value: <ChatModelSummary row={row} facts={facts} />,
            },
            ...compactPolicyRows(row, facts),
          ]}
        />
        {/* Same running note as the table's policy cell: a change waiting to apply shows at any width. */}
        <PolicyRunningNote row={row} facts={facts} />
      </div>
      <Button
        variant="ghost"
        color="secondary"
        aria-expanded={open}
        aria-controls={detailsId}
        iconEnd={
          <ChevronDownIcon
            className={css({
              transition: 'transform token(durations.check) token(easings.spring)',
              '[aria-expanded=true] &': { transform: 'rotate(180deg)' },
            })}
          />
        }
        onClick={() => setOpen((previous) => !previous)}
        // Ghost padding would push the label off the text edge above it.
        className={css({ alignSelf: 'flex-start', marginInlineStart: '-4' })}
      >
        {open ? t('pages.chats.hideSettings') : t('pages.chats.showSettings')}
      </Button>
      <div id={detailsId} hidden={!open}>
        {open ? <ChatSettingsDetails row={row} facts={facts} /> : null}
      </div>
    </li>
  );
}
