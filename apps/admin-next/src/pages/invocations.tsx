import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChatFilter,
  type ColumnSpec,
  ListPageHeader,
  ListSearchForm,
  QuerySelectField,
  QueryTextField,
  SnapshotList,
  StateBadge,
  TableShell,
  TechText,
  TimeText,
} from '@/components/business';
import { AppLink } from '@/components/router-links';
import type { InvocationListItem } from '@/lib/api/invocations.ts';
import { formatCost, formatNumber, stateLabel } from '@/lib/format';
import { chatQuery, optionalQuery, useListQuery } from '@/lib/list-query';
import { invocationsQuery } from '@/lib/queries';

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

export default function InvocationsPage(): ReactElement {
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
      width: 88,
      skeleton: '4127',
      render: (row) => (
        <AppLink to="/invocations/$invocationId" params={{ invocationId: row.id }}>
          {row.id}
        </AppLink>
      ),
    },
    {
      key: 'state',
      title: t('invocations.invocations.columns.state'),
      width: 140,
      render: (row) => <StateBadge state={row.state} />,
    },
    {
      key: 'chat',
      title: t('invocations.invocations.columns.chat'),
      render: (row) => (
        <div className={css({ minWidth: '0' })}>
          <div dir="auto" className={css({ truncate: true })}>
            {row.chat.title ?? <TechText>{row.chat.telegram_chat_id ?? row.chat.room_id}</TechText>}
          </div>
          <div className={css({ display: 'flex', gap: '2', textStyle: 'small', color: 'text-muted' })}>
            {row.chat.host_kind === 'playground' ? <span>{t('invocations.invocations.hosts.playground')}</span> : null}
            <span>{row.chat.type}</span>
            {row.chat.message_thread_id === 0 ? null : (
              <span>{t('invocations.invocations.topicLabel', { id: row.chat.message_thread_id })}</span>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'turns',
      title: t('invocations.invocations.columns.turns'),
      align: 'right',
      // Wide enough for the longest translated label ("الجولات" is 47px at 14px bold).
      width: 72,
      render: (row) => String(row.turns_used),
    },
    {
      key: 'tools',
      title: t('invocations.invocations.columns.tools'),
      align: 'right',
      width: 96,
      render: (row) => String(row.tool_call_count),
    },
    {
      key: 'sends',
      title: t('invocations.invocations.columns.sends'),
      align: 'right',
      // English "Sends" has no hyphenation point and is a hair wider than 72px leaves it, so it would split "Send/s".
      width: 80,
      render: (row) => String(row.sends_used),
    },
    {
      key: 'tokens',
      title: t('invocations.invocations.columns.tokens'),
      align: 'right',
      width: 96,
      render: (row) => formatNumber(row.total_tokens),
    },
    {
      key: 'cost',
      title: t('invocations.invocations.columns.cost'),
      align: 'right',
      width: 88,
      render: (row) => formatCost(row.total_cost),
    },
    {
      key: 'side-effect',
      title: t('invocations.invocations.columns.sideEffect'),
      width: 96,
      render: (row) =>
        row.side_effect_started ? (
          t('invocations.invocations.sideEffectStarted')
        ) : (
          <span className={css({ color: 'text-muted' })}>{t('invocations.invocations.sideEffectNone')}</span>
        ),
    },
    {
      key: 'created',
      title: t('invocations.invocations.columns.created'),
      width: 184,
      skeleton: '2026-01-18 10:58:15',
      render: (row) => <TimeText value={row.created_at} />,
    },
  ];

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <ListPageHeader title={t('layout.nav.toolSessions')} />
      <ListSearchForm value={query.value} emptyValue={EMPTY_FILTERS} onSearch={query.apply}>
        {({ draft, change }) => (
          <>
            <QuerySelectField
              label={t('invocations.invocations.statePlaceholder')}
              value={draft.state}
              onChange={(state) => change({ state })}
              options={INVOCATION_STATES.map((value) => ({ value, label: stateLabel(value) }))}
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
      <SnapshotList
        factory={invocationsQuery}
        filters={filters}
        renderItems={(items, { loading }) => (
          <TableShell columns={COLUMNS} data={items} rowKey={(row) => row.id} loading={loading} minWidth={1120} />
        )}
      />
    </div>
  );
}
