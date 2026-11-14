import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Empty } from '@tuuject/koi-react/empty';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Tag } from '@tuuject/koi-react/tag';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KvList, ListPageHeader, MonoValue, StateBadge, TimeText } from '@/components/business';
import { RefreshIcon } from '@/components/icons';
import { Panel } from '@/components/layout/panel';
import { getImageGeneration, imageUrl, retryImageGeneration } from '@/lib/api/images.ts';
import { errorMessage } from '@/lib/errors';
import { toast } from '@/lib/toast.ts';

/** One generation: intent snapshot, per-item attempts, outputs, and error. */

function ReferenceImage({
  asset,
  index,
}: {
  readonly asset: { readonly id: string; readonly name: string };
  readonly index: number;
}) {
  const [failed, setFailed] = useState(false);
  const { t } = useTranslation();
  return (
    <figure className={css({ minWidth: '0', '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
      {failed ? (
        <div
          className={css({
            textStyle: 'body',
            bg: 'surface-muted',
            color: 'text-muted',
            display: 'flex',
            aspectRatio: 'square',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'xl',
            padding: '4',
            textAlign: 'center',
          })}
        >
          {t('image.detail.imageLoadFailed')}
        </div>
      ) : (
        <a
          href={imageUrl(asset.id)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('image.detail.viewOriginal', { name: asset.name })}
          className={css({
            _focusVisible: {
              outlineColor: 'focus-ring',
              outlineWidth: '2px',
              outlineStyle: 'solid',
              outlineOffset: '2px',
            },
            display: 'block',
            borderRadius: 'xl',
          })}
        >
          <img
            src={imageUrl(asset.id)}
            alt={asset.name}
            onError={() => setFailed(true)}
            className={css({
              bg: 'surface-muted',
              aspectRatio: 'square',
              width: '100%',
              borderRadius: 'xl',
              objectFit: 'contain',
            })}
          />
        </a>
      )}
      <figcaption className={css({ textStyle: 'small', color: 'text-muted', overflowWrap: 'anywhere' })}>
        {index + 1}. {asset.name}
      </figcaption>
    </figure>
  );
}

function GenerationDetail({ id }: { readonly id: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['image-generation', id],
    queryFn: () => getImageGeneration(id),
    refetchInterval: (latest) => {
      const status = latest.state.data?.status;
      return status === 'queued' || status === 'running' ? 3000 : false;
    },
  });
  const retry = useMutation({
    mutationFn: () => retryImageGeneration(id),
    onSuccess: ({ generation }) => {
      toast.success(t('image.detail.resubmittedToast', { id: generation.id.slice(0, 8) }));
      void queryClient.invalidateQueries({ queryKey: ['image-generation', id] });
      void queryClient.invalidateQueries({ queryKey: ['image-generations'] });
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  if (query.isLoading) {
    return <p className={css({ margin: '0', color: 'text-muted' })}>{t('common.loading')}</p>;
  }
  if (query.data === undefined) {
    return <Empty title={t('image.detail.notFound')} />;
  }
  const record = query.data;
  const settled = record.status !== 'queued' && record.status !== 'running';

  return (
    <div className={css({ '& > * + *': { marginBlockStart: '6' } })}>
      <ListPageHeader
        title={`${record.id.slice(0, 8)}…`}
        description={<StateBadge state={record.status} />}
        actions={
          settled ? (
            <Button
              variant="outline"
              color="secondary"
              iconStart={<RefreshIcon />}
              loading={retry.isPending}
              loadingLabel={t('common.submitting')}
              onClick={() => retry.mutate()}
            >
              {t('common.retry')}
            </Button>
          ) : null
        }
      />
      <div
        className={css({
          display: 'grid',
          gap: '6',
          alignItems: 'start',
          '@media (min-width: 1024px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
        })}
      >
        <Panel title={t('invocations.invocationDetail.summary')}>
          <KvList
            items={[
              { label: t('image.detail.generationId'), value: <MonoValue value={record.id} /> },
              { label: t('image.detail.model'), value: record.snapshot.authored.modelId },
              {
                label: t('image.detail.ratioQuality'),
                value: `${record.snapshot.authored.aspectRatio} / ${record.snapshot.authored.resolution}`,
              },
              {
                label: t('image.detail.outputCount'),
                value: `${record.outputs.length}/${record.snapshot.authored.outputCount}`,
              },
              {
                label: t('image.detail.source'),
                value: (
                  <span className={css({ display: 'flex', flexWrap: 'wrap', columnGap: '2' })}>
                    <span>{record.source}</span>
                    {record.actorName === '' ? null : (
                      <span className={css({ color: 'text-muted' })}>{record.actorName}</span>
                    )}
                  </span>
                ),
              },
              { label: t('image.detail.submitted'), value: <TimeText value={record.createdAt} /> },
              {
                label: t('image.detail.finished'),
                value: record.finishedAt === null ? '—' : <TimeText value={record.finishedAt} />,
              },
              {
                label: t('image.detail.promptAssets'),
                value:
                  record.snapshot.promptAssets.length === 0 ? (
                    '—'
                  ) : (
                    <span className={css({ display: 'flex', flexWrap: 'wrap', gap: '2' })}>
                      {record.snapshot.promptAssets.map((asset) => (
                        <Tag key={asset.id}>{asset.name}</Tag>
                      ))}
                    </span>
                  ),
              },
            ]}
          />
        </Panel>
        {record.error !== null ? (
          <Alert tone="error" title={t('image.detail.errorPrefix', { code: record.error.code })}>
            {record.error.message}
          </Alert>
        ) : (
          <div
            className={css({
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: '3',
              md: { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
            })}
          >
            {record.outputs.map((output) => (
              <a key={output.id} href={imageUrl(output.id)} target="_blank" rel="noreferrer">
                <img
                  src={imageUrl(output.id)}
                  alt={output.name}
                  className={css({
                    display: 'block',
                    bg: 'surface-muted',
                    aspectRatio: 'square',
                    width: '100%',
                    borderRadius: 'xl',
                    objectFit: 'cover',
                  })}
                />
              </a>
            ))}
          </div>
        )}
      </div>
      <section
        aria-labelledby="reference-images-title"
        className={css({ display: 'flex', flexDirection: 'column', gap: '3' })}
      >
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '1' })}>
          <h2 id="reference-images-title" className={css({ margin: '0', textStyle: 'heading-2' })}>
            {t('image.detail.referenceImages')}
          </h2>
          {record.snapshot.imageAssets.length === 0 ? null : (
            <p className={css({ margin: '0', color: 'text-muted' })}>{t('image.detail.orderingHint')}</p>
          )}
        </div>
        {record.snapshot.imageAssets.length === 0 ? (
          <p className={css({ margin: '0', color: 'text-muted' })}>{t('image.detail.noReferenceImages')}</p>
        ) : (
          <div
            className={css({
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: '3',
              md: { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
              '@media (min-width: 1280px)': { gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' },
            })}
          >
            {record.snapshot.imageAssets.map((asset, index) => (
              <ReferenceImage key={asset.id} asset={asset} index={index} />
            ))}
          </div>
        )}
      </section>
      <Panel title={t('image.detail.attemptsTitle')}>
        {record.attempts.length === 0 ? (
          <p className={css({ margin: '0', color: 'text-muted' })}>{t('image.detail.noAttempts')}</p>
        ) : (
          <ul className={css({ '& > :not(:last-child)': { borderBottomWidth: '1px', borderColor: 'divider' } })}>
            {record.attempts.map((attempt) => (
              <li
                key={attempt.id}
                className={css({
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  columnGap: '4',
                  rowGap: '1',
                  paddingBlock: '3',
                })}
              >
                <StateBadge state={attempt.status} />
                <span>{t('image.detail.attemptRound', { round: attempt.round, item: attempt.itemIndex })}</span>
                {attempt.providerRequestId !== null && <MonoValue value={attempt.providerRequestId} />}
                {attempt.usage !== null &&
                  Object.entries(attempt.usage).map(([key, value]) => (
                    <span key={key} className={css({ color: 'text-muted' })}>{`${key} ${value}`}</span>
                  ))}
                {attempt.error !== null && (
                  <span className={css({ color: 'error-text' })}>{attempt.error.message}</span>
                )}
                {attempt.finishedAt !== null && (
                  <span className={css({ color: 'text-muted' })}>
                    <TimeText value={attempt.finishedAt} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title={t('image.detail.finalPromptLabel')}>
        <pre
          className={css({
            margin: '0',
            padding: '4',
            borderRadius: 'xl',
            bg: 'surface-muted',
            fontFamily: 'mono',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
          })}
        >
          {record.snapshot.finalPrompt}
        </pre>
      </Panel>
    </div>
  );
}

export default function ImageGenerationDetailPage() {
  const { generationId } = useParams({ from: '/image-generations_/$generationId' });
  return <GenerationDetail id={generationId} />;
}
