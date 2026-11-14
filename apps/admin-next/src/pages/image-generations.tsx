import { useQuery } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { PlusIcon } from '@tuuject/koi-react/icons';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ColumnSpec,
  ListFooter,
  ListPageHeader,
  ListToolbar,
  StateBadge,
  TableShell,
  TimeText,
  useOffsetPagination,
} from '@/components/business';
import { AppLink, ButtonLink } from '@/components/router-links';
import type { ImageGenerationRecord } from '@/lib/api/images.ts';
import { listImageGenerations } from '@/lib/api/images.ts';
import { errorMessage } from '@/lib/errors';

/** Generation audit list: every generation submitted from the panel or the agent. */

function GenerationList() {
  const { t } = useTranslation();
  const pagination = useOffsetPagination('image-generations');
  const generations = useQuery({
    queryKey: ['image-generations', pagination.pageSize, pagination.offset],
    queryFn: () => listImageGenerations({ limit: pagination.pageSize, offset: pagination.offset }),
    placeholderData: (previous) => previous,
    refetchInterval: (query) => {
      const statuses = query.state.data?.items.map((entry) => entry.status) ?? [];
      return statuses.some((status) => status === 'queued' || status === 'running') ? 3000 : false;
    },
  });
  const pageCount = pagination.pageCount(generations.data?.total);
  useEffect(() => {
    if (generations.data !== undefined && !generations.isPlaceholderData && pagination.page > pageCount) {
      pagination.onPageChange(pageCount);
    }
  }, [generations.data, generations.isPlaceholderData, pageCount, pagination]);

  const columns: readonly ColumnSpec<ImageGenerationRecord>[] = [
    {
      key: 'id',
      title: t('image.generations.columnGeneration'),
      width: 128,
      skeleton: 'a1b2c3d4…',
      render: (row) => (
        <AppLink to="/image-generations/$generationId" params={{ generationId: row.id }} aria-label={row.id}>
          <span className={css({ fontFamily: 'mono' })}>{row.id.slice(0, 8)}…</span>
        </AppLink>
      ),
    },
    {
      key: 'status',
      title: t('image.generations.columnStatus'),
      width: 120,
      render: (row) => <StateBadge state={row.status} />,
    },
    {
      key: 'model',
      title: t('image.generations.columnModel'),
      width: 200,
      render: (row) => (
        <span dir="ltr" className={css({ truncate: true, display: 'block', textAlign: 'start' })}>
          {row.snapshot.authored.modelId}
        </span>
      ),
    },
    {
      key: 'prompt',
      title: t('image.generations.columnPrompt'),
      render: (row) => (
        <span
          dir="auto"
          className={css({ truncate: true, display: 'block' })}
          title={row.snapshot.authored.authoredPrompt}
        >
          {row.snapshot.authored.authoredPrompt}
        </span>
      ),
    },
    {
      key: 'outputs',
      title: t('image.generations.columnOutputs'),
      align: 'right',
      width: 88,
      render: (row) => `${row.outputs.length}/${row.snapshot.authored.outputCount}`,
    },
    {
      key: 'source',
      title: t('image.generations.columnSource'),
      render: (row) => (
        <div className={css({ minWidth: '0' })}>
          <div>{row.source}</div>
          {row.actorName === '' ? null : (
            <div dir="auto" className={css({ textStyle: 'small', color: 'text-muted', truncate: true })}>
              {row.actorName}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'created',
      title: t('image.generations.columnSubmitted'),
      width: 184,
      skeleton: '2026-01-18 10:58:15',
      render: (row) => <TimeText value={row.createdAt} />,
    },
  ];

  const items = generations.data?.items ?? [];
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <ListToolbar onRefresh={() => void generations.refetch()} refreshing={generations.isRefetching}>
        <ButtonLink to="/image-generate" variant="outline" iconStart={<PlusIcon />}>
          {t('image.generations.newGeneration')}
        </ButtonLink>
      </ListToolbar>
      {generations.isError ? <Alert tone="error">{errorMessage(generations.error)}</Alert> : null}
      {generations.isPending || generations.data !== undefined ? (
        <div>
          <TableShell
            columns={columns}
            data={items}
            rowKey={(row) => row.id}
            loading={generations.isPending || generations.isPlaceholderData}
            minWidth={1000}
            emptyText={t('image.generations.empty')}
          />
          <ListFooter
            count={generations.data?.total ?? 0}
            page={pagination.page}
            pageCount={pageCount}
            busy={generations.isPlaceholderData}
            onPageChange={pagination.onPageChange}
          />
        </div>
      ) : null}
    </div>
  );
}

export default function ImageGenerationsPage() {
  const { t } = useTranslation();
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <ListPageHeader title={t('image.generations.title')} />
      <GenerationList />
    </div>
  );
}
