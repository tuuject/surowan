import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KvList, MonoValue, StateBadge } from '@/components/business';
import { Button } from '@tuuject/koi-react/button';
import { getImageGeneration, imageUrl, retryImageGeneration } from '@/lib/api/images.ts';

import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { toast } from '@/lib/toast.ts';
import { css } from '@tuuject/koi-react/styled-system/css';

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
        {index + 1} · {asset.name}
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
    return <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('common.loading')}</p>;
  }
  if (query.data === undefined) {
    return <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('image.detail.notFound')}</p>;
  }
  const record = query.data;
  const settled = record.status !== 'queued' && record.status !== 'running';

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
      <div className={css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between' })}>
        <div className={css({ display: 'flex', alignItems: 'center', gap: '3' })}>
          <h1 className={css({ textStyle: 'heading-3', fontFamily: 'mono' })}>{record.id.slice(0, 8)}…</h1>
          <StateBadge state={record.status} />
        </div>
        {settled && (
          <Button
            size="sm"
            variant="outline"
            color="secondary"
            onClick={() => retry.mutate()}
            disabled={retry.isPending}
          >
            {retry.isPending ? t('common.submitting') : t('common.retry')}
          </Button>
        )}
      </div>
      <div
        className={css({
          display: 'grid',
          gap: '4',
          '@media (min-width: 1024px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
        })}
      >
        <KvList
          items={[
            { label: t('image.detail.generationId'), value: <MonoValue value={record.id} /> },
            { label: t('image.detail.model'), value: record.snapshot.authored.modelId },
            {
              label: t('image.detail.ratioQuality'),
              value: `${record.snapshot.authored.aspectRatio} · ${record.snapshot.authored.resolution}`,
            },
            {
              label: t('image.detail.outputCount'),
              value: `${record.outputs.length}/${record.snapshot.authored.outputCount}`,
            },
            { label: t('image.detail.source'), value: `${record.source} · ${record.actorName}` },
            { label: t('image.detail.submitted'), value: formatTime(record.createdAt) },
            {
              label: t('image.detail.finished'),
              value: record.finishedAt === null ? '—' : formatTime(record.finishedAt),
            },
            {
              label: t('image.detail.promptAssets'),
              value:
                record.snapshot.promptAssets.length === 0 ? (
                  '—'
                ) : (
                  <span>
                    {record.snapshot.promptAssets.map((asset) => (
                      <span key={asset.id} className={css({ marginInlineEnd: '1', display: 'inline-block' })}>
                        {asset.name}
                      </span>
                    ))}
                  </span>
                ),
            },
          ]}
        />
        {record.error !== null ? (
          <div
            className={css({
              bg: 'error-surface',
              '& > :not(:last-child)': { marginBlockEnd: '1' },
              borderRadius: 'lg',
              padding: '3',
            })}
          >
            <div className={css({ textStyle: 'label' })}>
              {t('image.detail.errorPrefix', { code: record.error.code })}
            </div>
            <p className={css({ textStyle: 'body', overflowWrap: 'anywhere' })}>{record.error.message}</p>
          </div>
        ) : (
          <div
            className={css({
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: '2',
              md: { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
            })}
          >
            {record.outputs.map((output) => (
              <a key={output.id} href={imageUrl(output.id)} target="_blank" rel="noreferrer">
                <img
                  src={imageUrl(output.id)}
                  alt={output.name}
                  className={css({
                    bg: 'surface-muted',
                    aspectRatio: 'square',
                    width: '100%',
                    borderRadius: 'lg',
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
        className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}
      >
        <h2 id="reference-images-title" className={css({ textStyle: 'label' })}>
          {t('image.detail.referenceImages')}
        </h2>
        {record.snapshot.imageAssets.length === 0 ? (
          <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('image.detail.noReferenceImages')}</p>
        ) : (
          <>
            <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('image.detail.orderingHint')}</p>
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
          </>
        )}
      </section>
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
        <div className={css({ textStyle: 'label' })}>{t('image.detail.attemptsTitle')}</div>
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          {record.attempts.map((attempt) => (
            <div
              key={attempt.id}
              className={css({
                textStyle: 'small',
                bg: 'surface-muted',
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: '2',
                borderRadius: 'lg',
                paddingInline: '3',
                paddingBlock: '2',
              })}
            >
              <StateBadge state={attempt.status} />
              <span>
                round {attempt.round} · item {attempt.itemIndex}
              </span>
              {attempt.providerRequestId !== null && <MonoValue value={attempt.providerRequestId} />}
              {attempt.usage !== null && (
                <span className={css({ color: 'text-muted' })}>
                  {Object.entries(attempt.usage)
                    .map(([key, value]) => `${key} ${value}`)
                    .join(' · ')}
                </span>
              )}
              {attempt.error !== null && <span className={css({ color: 'error-text' })}>{attempt.error.message}</span>}
              {attempt.finishedAt !== null && (
                <span className={css({ color: 'text-muted' })}>{formatTime(attempt.finishedAt)}</span>
              )}
            </div>
          ))}
          {record.attempts.length === 0 && (
            <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('image.detail.noAttempts')}</p>
          )}
        </div>
      </div>
      <div className={css({ bg: 'surface-muted', borderRadius: 'lg', padding: '3' })}>
        <div className={css({ textStyle: 'small', color: 'text-muted' })}>{t('image.detail.finalPromptLabel')}</div>
        <pre className={css({ textStyle: 'small', whiteSpace: 'pre-wrap' })}>{record.snapshot.finalPrompt}</pre>
      </div>
    </div>
  );
}

export default function ImageGenerationDetailPage() {
  const { generationId } = useParams({ from: '/image-generations_/$generationId' });
  const { t } = useTranslation();
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
      <Link to="/image-generations" className={css({ textStyle: 'body', textDecorationLine: 'underline' })}>
        {t('image.detail.backToList')}
      </Link>
      <GenerationDetail id={generationId} />
    </div>
  );
}
