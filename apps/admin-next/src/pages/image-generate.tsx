import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Card } from '@tuuject/koi-react/card';
import { Field } from '@tuuject/koi-react/field';
import { PlusIcon } from '@tuuject/koi-react/icons';
import { Input } from '@tuuject/koi-react/input';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Tag } from '@tuuject/koi-react/tag';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListPageHeader } from '@/components/business';
import { ReferencePicker } from '@/components/image-generate/reference-picker.tsx';
import { imageRefToken, removeImageRefTokens } from '@/components/image-generate/prompt-refs.ts';
import { ReferencedStrip } from '@/components/image-generate/referenced-strip.tsx';
import { MarkdownInput, type MarkdownInsertHandle } from '@/components/prompts/markdown-input';
import { AppLink } from '@/components/router-links';
import type { ImageGenerationRecord } from '@/lib/api/images.ts';
import {
  getImageStatus,
  imageUrl,
  listImagePrompts,
  resolveImageGeneration,
  submitImageGeneration,
} from '@/lib/api/images.ts';
import { errorMessage } from '@/lib/errors';
import { toast } from '@/lib/toast.ts';

/**
 * The image workspace: compose a generation from prompt and reference
 * assets, preview the resolved snapshot without paying, submit, and watch the
 * outputs land. The prompt text is the single source of truth for referenced
 * images — picking an asset inserts its token at the caret, and the strip
 * under the field mirrors what the text references. Output pictures link into
 * the generation audit trail.
 */

const ASPECT_RATIOS = ['auto', '1:1', '2:3', '3:2', '4:3', '3:4', '16:9', '9:16'];
const RESOLUTIONS = ['auto', 'low', 'medium', 'high'] as const;
const QUALITY_LABEL_KEYS = {
  auto: 'image.settings.enumAuto',
  low: 'image.settings.enumLow',
  medium: 'image.settings.enumMedium',
  high: 'image.settings.enumHigh',
} as const;

function OutputGrid({ generation }: { readonly generation: ImageGenerationRecord }) {
  if (generation.outputs.length === 0) {
    return null;
  }
  return (
    <div
      className={css({
        display: 'grid',
        gap: '2',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        md: { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
      })}
    >
      {generation.outputs.map((output) => (
        <a
          key={output.id}
          href={imageUrl(output.id)}
          target="_blank"
          rel="noreferrer"
          className={css({ display: 'block' })}
        >
          <img
            src={imageUrl(output.id)}
            alt={output.name}
            className={css({
              bg: 'surface-muted',
              aspectRatio: 'square',
              width: '100%',
              borderRadius: 'xl',
              objectFit: 'cover',
            })}
          />
          <div className={css({ textStyle: 'small', color: 'text-muted', marginBlockStart: '1', truncate: true })}>
            {output.name}
          </div>
        </a>
      ))}
    </div>
  );
}

export default function ImageGeneratePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const insertRef = useRef<MarkdownInsertHandle | null>(null);
  const [prompt, setPrompt] = useState('');
  const [modelId, setModelId] = useState('');
  const [aspectRatio, setAspectRatio] = useState('auto');
  const [resolution, setResolution] = useState('auto');
  const [outputCount, setOutputCount] = useState(1);
  const [promptRefs, setPromptRefs] = useState<{ id: string; label: string }[]>([]);
  const [resolved, setResolved] = useState<string | null>(null);
  const [pending, setPending] = useState<ImageGenerationRecord | null>(null);

  const status = useQuery({ queryKey: ['image-status'], queryFn: getImageStatus, staleTime: 10_000 });
  const prompts = useQuery({
    queryKey: ['image-prompts-picker'],
    queryFn: () => listImagePrompts({ limit: 50 }),
  });

  const resolvePreview = useMutation({
    mutationFn: () =>
      resolveImageGeneration({
        prompt,
        model_id: modelId === '' ? undefined : modelId,
        aspect_ratio: aspectRatio,
        resolution,
        output_count: outputCount,
        prompt_refs: promptRefs.map((reference) => reference.id),
      }),
    onSuccess: (snapshot) => {
      const record = snapshot as { resolvedPrompt?: string; finalPrompt?: string };
      setResolved(record.finalPrompt ?? record.resolvedPrompt ?? JSON.stringify(snapshot));
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  const submit = useMutation({
    mutationFn: () =>
      submitImageGeneration({
        prompt,
        model_id: modelId === '' ? undefined : modelId,
        aspect_ratio: aspectRatio,
        resolution,
        output_count: outputCount,
        prompt_refs: promptRefs.map((reference) => reference.id),
        idempotency_key: `admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      }),
    onSuccess: ({ generation, replayed }) => {
      toast.success(replayed ? t('image.generate.replayedToast') : t('image.generate.submittedToast'));
      setPending(generation);
      queryClient.invalidateQueries({ queryKey: ['image-generations'] });
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  if (status.data !== undefined && !status.data.enabled) {
    return (
      <div>
        <ListPageHeader title={t('image.generate.title')} />
        <Alert tone="info">
          {t('image.generate.disabledIntro')}
          <AppLink to="/image-settings">{t('image.generate.disabledLink')}</AppLink>
        </Alert>
      </div>
    );
  }

  /** Picks land at the caret; without one they append at the end. */
  const insertAsset = (asset: { readonly id: string }) => {
    insertRef.current?.insertAtCursor(imageRefToken(asset.id));
  };

  const addPromptRef = (entry: { readonly id: string; readonly name: string }) =>
    setPromptRefs((current) =>
      current.some((reference) => reference.id === entry.id)
        ? current
        : [...current, { id: entry.id, label: entry.name }],
    );

  return (
    <div>
      <ListPageHeader title={t('image.generate.title')} />
      {/* The form and this run's outputs stack vertically at every width. */}
      <div className={css({ display: 'grid', gap: '6' })}>
        <Card>
          <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
            <Field label={t('image.generate.promptLabel')}>
              <MarkdownInput
                value={prompt}
                onChange={setPrompt}
                insertRef={insertRef}
                placeholder={t('image.generate.promptPlaceholder', {
                  promptRef: '{{prompt:…}}',
                  imageRef: '{{image:…}}',
                })}
              />
            </Field>
            <ReferencedStrip
              prompt={prompt}
              onRemove={(id) => setPrompt((current) => removeImageRefTokens(current, id))}
            />
            <ReferencePicker onPick={insertAsset} />
            <div className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
              <h3 className={css({ margin: '0', textStyle: 'label' })}>{t('image.generate.promptAssets')}</h3>
              <div
                className={css({
                  display: 'flex',
                  maxHeight: '112px',
                  flexWrap: 'wrap',
                  gap: '2',
                  overflowY: 'auto',
                })}
              >
                {prompts.data?.items.map((entry) => (
                  <Tag key={entry.id} icon={<PlusIcon />} onSelectedChange={() => addPromptRef(entry)}>
                    {entry.name}
                  </Tag>
                ))}
              </div>
              {promptRefs.length > 0 ? (
                <div className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
                  <h4 className={css({ margin: '0', textStyle: 'label' })}>{t('image.generate.selectedPromptRefs')}</h4>
                  <div className={css({ display: 'flex', flexWrap: 'wrap', gap: '2' })}>
                    {promptRefs.map((reference) => (
                      <Tag
                        key={reference.id}
                        onRemove={() =>
                          setPromptRefs((current) => current.filter((entry) => entry.id !== reference.id))
                        }
                      >
                        {reference.label}
                      </Tag>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            {/* A container query measures an ancestor, never the element that declares it, so the grid needs a wrapper. */}
            <div className={css({ containerType: 'inline-size' })}>
              <div
                className={css({
                  display: 'grid',
                  gap: '4',
                  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                  '@container (min-width: 640px)': { gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' },
                })}
              >
                <Field label={t('image.generate.model')}>
                  <Select
                    value={modelId}
                    onChange={(event) => setModelId(event.target.value)}
                    options={[
                      { value: '', label: t('image.generate.defaultModelOption') },
                      ...(status.data?.models ?? []).map((model) => ({ value: model.id, label: model.name })),
                    ]}
                  />
                </Field>
                <Field label={t('image.generate.aspectRatio')}>
                  <Select
                    value={aspectRatio}
                    onChange={(event) => setAspectRatio(event.target.value)}
                    options={ASPECT_RATIOS.map((value) => ({
                      value,
                      label: value === 'auto' ? t('image.settings.enumAuto') : value,
                    }))}
                  />
                </Field>
                <Field label={t('image.generate.quality')}>
                  <Select
                    value={resolution}
                    onChange={(event) => setResolution(event.target.value)}
                    options={RESOLUTIONS.map((value) => ({ value, label: t(QUALITY_LABEL_KEYS[value]) }))}
                  />
                </Field>
                <Field label={t('image.generate.count')}>
                  <Input
                    type="number"
                    min={1}
                    max={4}
                    value={outputCount}
                    onChange={(event) => setOutputCount(Math.min(4, Math.max(1, Number(event.target.value) || 1)))}
                    dir="ltr"
                  />
                </Field>
              </div>
            </div>
            {resolved !== null && (
              <div className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
                <h3 className={css({ margin: '0', textStyle: 'label' })}>{t('image.generate.resolvedPromptLabel')}</h3>
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
                  {resolved}
                </pre>
              </div>
            )}
            <div className={css({ display: 'flex', flexWrap: 'wrap', gap: '2' })}>
              <Button
                loading={submit.isPending}
                loadingLabel={t('common.submitting')}
                disabled={prompt.trim() === ''}
                onClick={() => submit.mutate()}
              >
                {t('image.generate.generate')}
              </Button>
              <Button
                variant="outline"
                color="secondary"
                loading={resolvePreview.isPending}
                loadingLabel={t('image.generate.resolving')}
                disabled={prompt.trim() === ''}
                onClick={() => resolvePreview.mutate()}
              >
                {t('image.generate.resolvePreview')}
              </Button>
            </div>
          </div>
        </Card>
        <Card
          title={t('image.generate.outputsTitle')}
          {...(pending === null
            ? {}
            : {
                footer: (
                  <AppLink to="/image-generations/$generationId" params={{ generationId: pending.id }}>
                    {t('image.generate.auditDetail')}
                  </AppLink>
                ),
              })}
        >
          {pending === null ? (
            <p className={css({ margin: '0', color: 'text-muted' })}>{t('image.generate.outputsPlaceholder')}</p>
          ) : (
            <OutputGrid generation={pending} />
          )}
        </Card>
      </div>
    </div>
  );
}
