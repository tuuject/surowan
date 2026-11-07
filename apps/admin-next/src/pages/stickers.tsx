import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ColumnSpec,
  CursorList,
  JsonViewer,
  LIST_TABLE_CLASS,
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api/core.ts';
import type { StickerEntry, StickerSetEntry } from '@/lib/api/stickers.ts';
import { formatNumber, formatTime } from '@/lib/format';
import { optionalQuery, useListQuery } from '@/lib/list-query';
import { stickerSetsQuery, stickersQuery } from '@/lib/queries';

const INDEX_STATES = ['pending', 'running', 'success', 'error'] as const;
const EMPTY_FILTERS = { set: '', state: '', search: '' };

const CODE = 'bg-muted rounded px-1 py-0.5 font-mono text-xs';

function ConfiguredBadge({ configured }: { readonly configured: boolean }): React.ReactElement {
  const { t } = useTranslation();
  return configured ? (
    <ToneBadge tone="success">{t('pages.stickers.yes')}</ToneBadge>
  ) : (
    <ToneBadge tone="neutral">{t('pages.stickers.disabled')}</ToneBadge>
  );
}

function Section({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: React.ReactNode;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="font-semibold">{title}</h2>
        <p className="text-muted-foreground max-w-3xl text-sm">{description}</p>
      </div>
      {children}
    </section>
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
        <div className="space-y-0.5">
          <div className="font-medium">{row.title ?? row.alias}</div>
          <div className="text-muted-foreground text-xs">
            {row.alias} · {row.telegram_name}
          </div>
        </div>
      ),
    },
    {
      key: 'configured',
      title: t('pages.stickers.colConfigured'),
      render: (row) => <ConfiguredBadge configured={row.configured} />,
    },
    { key: 'sync_state', title: t('pages.stickers.colSync'), render: (row) => <StateBadge state={row.sync_state} /> },
    {
      key: 'sticker_count',
      title: t('pages.stickers.colStickers'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => formatNumber(row.sticker_count),
    },
    {
      key: 'indexed_count',
      title: t('pages.stickers.colIndexed'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => formatNumber(row.indexed_count),
    },
    {
      key: 'pending_count',
      title: t('pages.stickers.colPending'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => formatNumber(row.pending_count),
    },
    {
      key: 'error_count',
      title: t('pages.stickers.colErrors'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => formatNumber(row.error_count),
    },
    {
      key: 'error_code',
      title: t('pages.stickers.colError'),
      className: 'ps-6',
      render: (row) => <TextValue value={row.error_code} />,
    },
    {
      key: 'last_synced_at',
      title: t('pages.stickers.colLastSynced'),
      className: 'text-muted-foreground',
      render: (row) => formatTime(row.last_synced_at),
    },
  ];

  const stickerColumns: readonly ColumnSpec<StickerEntry>[] = [
    {
      key: 'emoji',
      title: t('pages.stickers.colSticker'),
      render: (row) => (
        <div className="space-y-0.5">
          <div>{row.emoji ?? <span className="text-muted-foreground">—</span>}</div>
          <div className="text-muted-foreground text-xs">
            {row.set_alias} · {row.format}
          </div>
        </div>
      ),
    },
    {
      key: 'index_state',
      title: t('pages.stickers.colIndexState'),
      render: (row) => <StateBadge state={row.index_state} />,
    },
    {
      key: 'description',
      title: t('pages.stickers.colDescription'),
      className: 'min-w-64 whitespace-normal',
      render: (row) => (
        <p className="line-clamp-2 max-w-md break-words">
          {row.analysis?.description ?? <span className="text-muted-foreground">—</span>}
        </p>
      ),
    },
    {
      key: 'model',
      title: t('pages.stickers.colModel'),
      render: (row) =>
        row.analysis === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          `${row.analysis.provider ?? '?'}/${row.analysis.model ?? '?'}`
        ),
    },
    {
      key: 'failure_count',
      title: t('pages.stickers.colFailures'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => formatNumber(row.failure_count),
    },
    {
      key: 'updated_at',
      title: t('pages.stickers.colUpdated'),
      className: 'text-muted-foreground ps-6',
      render: (row) => formatTime(row.updated_at),
    },
  ];

  return (
    <div className="space-y-8">
      <ListPageHeader title={t('layout.nav.botStickerSets')} />
      <Section
        title={t('pages.stickers.setsTitle')}
        description={
          <>
            {t('pages.stickers.setsDescPre')} <code className={CODE}>telegram.sticker_sets</code>{' '}
            {t('pages.stickers.setsDescPost')}
          </>
        }
      >
        {sets.isPending ? <Skeleton className="h-32 w-full rounded-xl" /> : null}
        {sets.isError ? (
          <Alert variant="destructive">
            <AlertTitle>{t('pages.stickers.loadSetsFailed')}</AlertTitle>
            <AlertDescription>
              {sets.error instanceof ApiError
                ? `${sets.error.code}: ${sets.error.message}`
                : sets.error instanceof Error
                  ? sets.error.message
                  : t('pages.stickers.adminRequestFailed')}
            </AlertDescription>
          </Alert>
        ) : null}
        {!sets.isPending && !sets.isError ? (
          <div>
            <TableShell
              columns={setColumns}
              data={setPagination.items}
              rowKey={(row) => row.id}
              emptyText={t('pages.stickers.emptySets')}
              className={LIST_TABLE_CLASS}
            />
            <ListFooter
              count={setPagination.total}
              page={setPagination.page}
              pageCount={setPagination.pageCount}
              onPageChange={setPagination.onPageChange}
            />
          </div>
        ) : null}
      </Section>
      <Section
        title={t('pages.stickers.indexTitle')}
        description={
          <>
            {t('pages.stickers.indexDescPre')} <code className={CODE}>search_stickers</code>{' '}
            {t('pages.stickers.indexDescMid')} <code className={CODE}>execute</code>
            {t('pages.stickers.indexDescPost')}
          </>
        }
      >
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
              frame={false}
              expandedRender={(row) => (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-xs">{t('pages.stickers.nextRetry')}</p>
                    <p>{formatTime(row.next_retry_at)}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-xs">{t('pages.stickers.analysisVersion')}</p>
                    <TextValue value={row.analysis?.analysis_version ?? null} />
                  </div>
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-xs">{t('pages.stickers.colDescription')}</p>
                    <p className="break-words whitespace-pre-wrap">{row.analysis?.description ?? '—'}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-xs">{t('pages.stickers.metadata')}</p>
                    <JsonViewer value={row.analysis?.metadata_json ?? null} />
                  </div>
                </div>
              )}
            />
          )}
        />
      </Section>
    </div>
  );
}
