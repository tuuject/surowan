import { useQuery } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ColumnSpec,
  CursorList,
  JsonViewer,
  ListFooter,
  ListPageHeader,
  ListSearchForm,
  QuerySelectField,
  QueryTextField,
  StateBadge,
  TableShell,
  TextValue,
  ToneBadge,
  useClientPagination,
} from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { ApiError } from '@/lib/api/core.ts';
import type { StickerEntry, StickerSetEntry } from '@/lib/api/stickers.ts';
import { formatNumber, formatTime } from '@/lib/format';
import { optionalQuery, useListQuery } from '@/lib/list-query';
import { stickerSetsQuery, stickersQuery } from '@/lib/queries';

const INDEX_STATES = ['pending', 'running', 'success', 'error'] as const;
const EMPTY_FILTERS = { set: '', state: '', search: '' };

const CODE = css({ fontFamily: 'mono' });

function ConfiguredBadge({ configured }: { readonly configured: boolean }): React.ReactElement {
  const { t } = useTranslation();
  return configured ? (
    <ToneBadge tone="success">{t('pages.stickers.yes')}</ToneBadge>
  ) : (
    <ToneBadge tone="neutral">{t('pages.stickers.disabled')}</ToneBadge>
  );
}

/** A page section heading for the list that follows it; the list itself stays on the page, not in a card. */
function SectionHeading({
  title,
  description,
}: {
  readonly title: string;
  readonly description: React.ReactNode;
}): React.ReactElement {
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '1' })}>
      <h2 className={css({ margin: '0', textStyle: 'heading-2' })}>{title}</h2>
      <p className={css({ margin: '0', color: 'text-muted', maxWidth: 'content-max' })}>{description}</p>
    </div>
  );
}

export default function StickersPage(): React.ReactElement {
  const { t } = useTranslation();
  const query = useListQuery(EMPTY_FILTERS);
  const { set, state, search } = query.value;
  const sets = useQuery(stickerSetsQuery);
  const setPagination = useClientPagination(sets.data?.items ?? [], 'sticker-sets');
  const filters = useMemo(
    () => ({ set: optionalQuery(set), state: optionalQuery(state), search: optionalQuery(search) }),
    [set, state, search],
  );

  const setOptions = (sets.data?.items ?? []).map((entry) => ({ value: entry.alias, label: entry.alias }));

  const setColumns: readonly ColumnSpec<StickerSetEntry>[] = [
    {
      key: 'alias',
      title: t('pages.stickers.colSet'),
      render: (row) => (
        <div className={css({ minWidth: '0' })}>
          <div className={css({ truncate: true })}>{row.title ?? row.alias}</div>
          <div className={css({ display: 'flex', gap: '2', textStyle: 'small', color: 'text-muted' })}>
            <span>{row.alias}</span>
            <span>{row.telegram_name}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'configured',
      title: t('pages.stickers.colConfigured'),
      width: 104,
      render: (row) => <ConfiguredBadge configured={row.configured} />,
    },
    {
      key: 'sync_state',
      title: t('pages.stickers.colSync'),
      width: 112,
      render: (row) => <StateBadge state={row.sync_state} />,
    },
    {
      key: 'sticker_count',
      title: t('pages.stickers.colStickers'),
      align: 'right',
      width: 88,
      render: (row) => formatNumber(row.sticker_count),
    },
    {
      key: 'indexed_count',
      title: t('pages.stickers.colIndexed'),
      align: 'right',
      width: 88,
      render: (row) => formatNumber(row.indexed_count),
    },
    {
      key: 'pending_count',
      title: t('pages.stickers.colPending'),
      align: 'right',
      width: 88,
      render: (row) => formatNumber(row.pending_count),
    },
    {
      key: 'error_count',
      title: t('pages.stickers.colErrors'),
      align: 'right',
      width: 88,
      render: (row) => formatNumber(row.error_count),
    },
    {
      key: 'error_code',
      title: t('pages.stickers.colError'),
      render: (row) => <TextValue value={row.error_code} />,
    },
    {
      key: 'last_synced_at',
      title: t('pages.stickers.colLastSynced'),
      width: 184,
      skeleton: '2026-01-18 10:58:15',
      render: (row) => formatTime(row.last_synced_at),
    },
  ];

  const stickerColumns: readonly ColumnSpec<StickerEntry>[] = [
    {
      key: 'emoji',
      title: t('pages.stickers.colSticker'),
      render: (row) => (
        <div className={css({ minWidth: '0' })}>
          <div>{row.emoji ?? <span className={css({ color: 'text-muted' })}>—</span>}</div>
          <div className={css({ display: 'flex', gap: '2', textStyle: 'small', color: 'text-muted' })}>
            <span>{row.set_alias}</span>
            <span>{row.format}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'index_state',
      title: t('pages.stickers.colIndexState'),
      width: 112,
      render: (row) => <StateBadge state={row.index_state} />,
    },
    {
      key: 'description',
      title: t('pages.stickers.colDescription'),
      render: (row) => (
        <p className={css({ margin: '0', lineClamp: '2', whiteSpace: 'normal', overflowWrap: 'anywhere' })}>
          {row.analysis?.description ?? <span className={css({ color: 'text-muted' })}>—</span>}
        </p>
      ),
    },
    {
      key: 'model',
      title: t('pages.stickers.colModel'),
      render: (row) =>
        row.analysis === null ? (
          <span className={css({ color: 'text-muted' })}>—</span>
        ) : (
          `${row.analysis.provider ?? '?'}/${row.analysis.model ?? '?'}`
        ),
    },
    {
      key: 'failure_count',
      title: t('pages.stickers.colFailures'),
      align: 'right',
      width: 96,
      render: (row) => formatNumber(row.failure_count),
    },
    {
      key: 'updated_at',
      title: t('pages.stickers.colUpdated'),
      width: 184,
      skeleton: '2026-01-18 10:58:15',
      render: (row) => formatTime(row.updated_at),
    },
  ];

  return (
    <div className={css({ '& > * + *': { marginBlockStart: '5' } })}>
      <ListPageHeader title={t('layout.nav.botStickerSets')} />
      <Panel
        title={t('pages.stickers.setsTitle')}
        description={
          <>
            {t('pages.stickers.setsDescPre')} <code className={CODE}>telegram.sticker_sets</code>{' '}
            {t('pages.stickers.setsDescPost')}
          </>
        }
      >
        {sets.isError ? (
          <Alert tone="error" title={t('pages.stickers.loadSetsFailed')}>
            {sets.error instanceof ApiError
              ? `${sets.error.code}: ${sets.error.message}`
              : sets.error instanceof Error
                ? sets.error.message
                : t('pages.stickers.adminRequestFailed')}
          </Alert>
        ) : (
          <div>
            <TableShell
              columns={setColumns}
              data={setPagination.items}
              rowKey={(row) => row.id}
              loading={sets.isPending}
              skeletonRows={2}
              minWidth={960}
              emptyText={t('pages.stickers.emptySets')}
            />
            {sets.isPending ? null : (
              <ListFooter
                count={setPagination.total}
                page={setPagination.page}
                pageCount={setPagination.pageCount}
                onPageChange={setPagination.onPageChange}
              />
            )}
          </div>
        )}
      </Panel>
      <div className={css({ paddingBlockStart: '6' })}>
        <SectionHeading
          title={t('pages.stickers.indexTitle')}
          description={
            <>
              {t('pages.stickers.indexDescPre')} <code className={CODE}>search_stickers</code>{' '}
              {t('pages.stickers.indexDescMid')} <code className={CODE}>execute</code>
              {t('pages.stickers.indexDescPost')}
            </>
          }
        />
      </div>
      <ListSearchForm value={query.value} emptyValue={EMPTY_FILTERS} onSearch={query.apply}>
        {({ draft, change }) => (
          <>
            <QuerySelectField
              label={t('pages.stickers.filterSet')}
              value={draft.set}
              onChange={(set) => change({ set })}
              options={setOptions}
            />
            <QuerySelectField
              label={t('pages.stickers.filterState')}
              value={draft.state}
              onChange={(state) => change({ state })}
              options={INDEX_STATES.map((value) => ({ value, label: value }))}
            />
            <QueryTextField
              label={t('pages.stickers.filterSearch')}
              value={draft.search}
              onChange={(search) => change({ search })}
            />
          </>
        )}
      </ListSearchForm>
      <CursorList
        factory={stickersQuery}
        filters={filters}
        renderItems={(items, { loading }) => (
          <TableShell
            columns={stickerColumns}
            data={items}
            rowKey={(row) => row.id}
            loading={loading}
            minWidth={1000}
            expandedRender={(row) => (
              <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
                <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
                  <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('pages.stickers.nextRetry')}</p>
                  <p>{formatTime(row.next_retry_at)}</p>
                </div>
                <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
                  <p className={css({ textStyle: 'small', color: 'text-muted' })}>
                    {t('pages.stickers.analysisVersion')}
                  </p>
                  <TextValue value={row.analysis?.analysis_version ?? null} />
                </div>
                <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
                  <p className={css({ textStyle: 'small', color: 'text-muted' })}>
                    {t('pages.stickers.colDescription')}
                  </p>
                  <p className={css({ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' })}>
                    {row.analysis?.description ?? '—'}
                  </p>
                </div>
                <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
                  <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('pages.stickers.metadata')}</p>
                  <JsonViewer value={row.analysis?.metadata_json ?? null} />
                </div>
              </div>
            )}
          />
        )}
      />
    </div>
  );
}
