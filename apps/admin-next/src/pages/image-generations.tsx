import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ColumnSpec,
  ListFooter,
  ListPageHeader,
  ListToolbar,
  StateBadge,
  TableShell,
  useOffsetPagination,
} from '@/components/business';
import { PlusIcon } from '@tuuject/koi-react/icons';
import { ButtonLink } from '@/components/router-links';
import type { ImageGenerationRecord } from '@/lib/api/images.ts';
import { listImageGenerations } from '@/lib/api/images.ts';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { css } from '@tuuject/koi-react/styled-system/css';

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
      render: (row) => (
        <Link
          to="/image-generations/$generationId"
          params={{ generationId: row.id }}
          aria-label={row.id}
          className={css({
            textStyle: 'small',
            fontFamily: 'mono',
            wordBreak: 'break-all',
            textUnderlineOffset: '4px',
            _hover: { textDecorationLine: 'underline' },
          })}
        >
          {row.id.slice(0, 8)}…
        </Link>
      ),
    },
    { key: 'status', title: t('image.generations.columnStatus'), render: (row) => <StateBadge state={row.status} /> },
    { key: 'model', title: t('image.generations.columnModel'), render: (row) => row.snapshot.authored.modelId },
    {
      key: 'prompt',
      title: t('image.generations.columnPrompt'),
      render: (row) => (
        <span className={css({ textStyle: 'small', lineClamp: '1', maxWidth: '288px' })}>
          {row.snapshot.authored.authoredPrompt}
        </span>
      ),
    },
    {
      key: 'outputs',
      title: t('image.generations.columnOutputs'),
      render: (row) => `${row.outputs.length}/${row.snapshot.authored.outputCount}`,
    },
    {
      key: 'source',
      title: t('image.generations.columnSource'),
      render: (row) => `${row.source}${row.actorName === '' ? '' : ` · ${row.actorName}`}`,
    },
    { key: 'created', title: t('image.generations.columnSubmitted'), render: (row) => formatTime(row.createdAt) },
  ];

  const items = generations.data?.items ?? [];
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
      <ListToolbar onRefresh={() => void generations.refetch()} refreshing={generations.isRefetching} />
      {generations.isError ? (
        <p role="alert" className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
          {errorMessage(generations.error)}
        </p>
      ) : null}
      {generations.isPending || generations.data !== undefined ? (
        <div>
          <TableShell
            columns={columns}
            data={items}
            rowKey={(row) => row.id}
            loading={generations.isPending || generations.isPlaceholderData}
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
      <ListPageHeader
        title={t('image.generations.title')}
        actions={
          <ButtonLink to="/image-generate" iconStart={<PlusIcon />}>
            {t('image.generations.newGeneration')}
          </ButtonLink>
        }
      />
      <GenerationList />
    </div>
  );
}
