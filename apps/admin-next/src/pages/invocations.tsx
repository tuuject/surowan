import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChatFilter,
  type ColumnSpec,
  CursorList,
  ListPageHeader,
  ListSearchForm,
  QuerySelectField,
  QueryTextField,
  StateBadge,
  TableShell,
} from '@/components/business';
import type { InvocationListItem } from '@/lib/api/invocations.ts';
import { formatCost, formatNumber, formatTime } from '@/lib/format';
import { chatQuery, optionalQuery, useListQuery } from '@/lib/list-query';
import { invocationsQuery } from '@/lib/queries';
import { css } from '@tuuject/koi-react/styled-system/css';

const INVOCATION_STATES = [
  'queued',
  'running',
  'completed',
  'failed',
  'aborted',
  'outcome_unknown',
  'skipped_budget',
] as const;

const INVOCATION_HOSTS = ['telegram', 'playground'] as const;
const EMPTY_FILTERS = { state: '', host: '', chat: '', model: '' };

export default function InvocationsPage(): React.ReactElement {
  const { t } = useTranslation();
  const query = useListQuery(EMPTY_FILTERS);
  const { state, host, chat, model } = query.value;
  const filters = useMemo(
    () => ({
      state: optionalQuery(state),
      host: optionalQuery(host),
      chat: chatQuery(chat),
      model: optionalQuery(model),
    }),
    [state, host, chat, model],
  );

  const COLUMNS: readonly ColumnSpec<InvocationListItem>[] = [
    {
      key: 'id',
      title: t('invocations.invocations.columns.id'),
      render: (row) => (
        <Link
          to="/invocations/$invocationId"
          params={{ invocationId: row.id }}
          className={css({
            textStyle: 'label',
            textDecorationColor: 'border',
            fontVariantNumeric: 'tabular-nums',
            textDecorationLine: 'underline',
            textUnderlineOffset: '4px',
            transitionProperty: 'color, background-color, border-color',
            transitionDuration: 'fast',
            _hover: { textDecorationColor: 'text' },
          })}
        >
          {row.id}
        </Link>
      ),
    },
    {
      key: 'state',
      title: t('invocations.invocations.columns.state'),
      render: (row) => <StateBadge state={row.state} />,
    },
    {
      key: 'chat',
      title: t('invocations.invocations.columns.chat'),
      render: (row) => (
        <div className={css({ minWidth: '0', '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          <div className={css({ textStyle: 'label' })}>
            {row.chat.title ?? row.chat.telegram_chat_id ?? row.chat.room_id}
          </div>
          <div className={css({ textStyle: 'small', color: 'text-muted' })}>
            {row.chat.host_kind === 'playground' ? `${t('invocations.invocations.hosts.playground')} · ` : ''}
            {row.chat.type}
            {row.chat.message_thread_id === 0 ? '' : ` · topic ${row.chat.message_thread_id}`}
          </div>
        </div>
      ),
    },
    {
      key: 'turns',
      title: t('invocations.invocations.columns.turns'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => String(row.turns_used),
    },
    {
      key: 'tools',
      title: t('invocations.invocations.columns.tools'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => String(row.tool_call_count),
    },
    {
      key: 'sends',
      title: t('invocations.invocations.columns.sends'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => String(row.sends_used),
    },
    {
      key: 'tokens',
      title: t('invocations.invocations.columns.tokens'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => formatNumber(row.total_tokens),
    },
    {
      key: 'cost',
      title: t('invocations.invocations.columns.cost'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => formatCost(row.total_cost),
    },
    {
      key: 'side-effect',
      title: t('invocations.invocations.columns.sideEffect'),
      className: 'ps-6',
      render: (row) =>
        row.side_effect_started ? 'started' : <span className={css({ color: 'text-muted' })}>none</span>,
    },
    {
      key: 'created',
      title: t('invocations.invocations.columns.created'),
      className: 'text-muted-foreground',
      render: (row) => formatTime(row.created_at),
    },
  ];

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <ListPageHeader title={t('layout.nav.toolSessions')} description={t('invocations.invocations.tokensNote')} />
      <ListSearchForm value={query.value} emptyValue={EMPTY_FILTERS} onSearch={query.apply}>
        {({ draft, change }) => (
          <>
            <QuerySelectField
              label={t('invocations.invocations.statePlaceholder')}
              value={draft.state}
              onChange={(state) => change({ state })}
              options={INVOCATION_STATES.map((value) => ({ value, label: value }))}
            />
            <QuerySelectField
              label={t('invocations.invocations.hostPlaceholder')}
              value={draft.host}
              onChange={(host) => change({ host })}
              options={INVOCATION_HOSTS.map((value) => ({ value, label: t(`invocations.invocations.hosts.${value}`) }))}
            />
            <ChatFilter value={draft.chat} onChange={(chat) => change({ chat })} />
            <QueryTextField
              label={t('invocations.invocations.modelPlaceholder')}
              value={draft.model}
              onChange={(model) => change({ model })}
            />
          </>
        )}
      </ListSearchForm>
      <CursorList
        factory={invocationsQuery}
        filters={filters}
        renderItems={(items, { loading }) => (
          <TableShell columns={COLUMNS} data={items} rowKey={(row) => row.id} loading={loading} />
        )}
      />
    </div>
  );
}
