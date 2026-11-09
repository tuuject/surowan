import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Card } from '@tuuject/koi-react/card';
import { Field } from '@tuuject/koi-react/field';
import { PlusIcon, UploadIcon } from '@tuuject/koi-react/icons';
import { Input } from '@tuuject/koi-react/input';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Tag } from '@tuuject/koi-react/tag';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListPageHeader } from '@/components/business';
import { MarkdownInput } from '@/components/prompts/markdown-input';
import { AppLink } from '@/components/router-links';
import type { ImageGenerationRecord } from '@/lib/api/images.ts';
import {
  getImageStatus,
  imageUrl,
  listImageAssets,
  listImagePrompts,
  resolveImageGeneration,
  submitImageGeneration,
  uploadImageAsset as uploadAsset,
} from '@/lib/api/images.ts';
import { errorMessage } from '@/lib/errors';
import { toast } from '@/lib/toast.ts';

/**
 * The image workspace: compose a generation from prompt and reference
 * assets, preview the resolved snapshot without paying, submit, and watch the
 * outputs land. Output pictures link into the generation audit trail.
 */

const ASPECT_RATIOS = ['auto', '1:1', '2:3', '3:2', '4:3', '3:4', '16:9', '9:16'];
const RESOLUTIONS = ['auto', 'low', 'medium', 'high'];

function SelectedRefs({
  title,
  refs,
  onRemove,
}: {
  title: string;
  refs: readonly { readonly id: string; readonly label: string }[];
  onRemove: (id: string) => void;
}) {
  if (refs.length === 0) {
    return null;
  }
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
      <h3 className={css({ margin: '0', textStyle: 'label' })}>{title}</h3>
      <div className={css({ display: 'flex', flexWrap: 'wrap', gap: '2' })}>
        {refs.map((reference) => (
          <Tag key={reference.id} onRemove={() => onRemove(reference.id)}>
            {reference.label}
          </Tag>
        ))}
      </div>
    </div>
  );
}

function OutputGrid({ generation }: { readonly generation: ImageGenerationRecord }) {
  if (generation.outputs.length === 0) {
    return null;
  }
  return (
    <div
      className={css({
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: '2',
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
  const fileInput = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState('');
  const [modelId, setModelId] = useState('');
  const [aspectRatio, setAspectRatio] = useState('auto');
  const [resolution, setResolution] = useState('auto');
  const [outputCount, setOutputCount] = useState(1);
  const [promptRefs, setPromptRefs] = useState<{ id: string; label: string }[]>([]);
  const [imageRefs, setImageRefs] = useState<{ id: string; label: string }[]>([]);
  const [resolved, setResolved] = useState<string | null>(null);
  const [pending, setPending] = useState<ImageGenerationRecord | null>(null);

  const status = useQuery({ queryKey: ['image-status'], queryFn: getImageStatus, staleTime: 10_000 });
  const prompts = useQuery({
    queryKey: ['image-prompts-picker'],
    queryFn: () => listImagePrompts({ limit: 50 }),
  });
  const assets = useQuery({ queryKey: ['image-assets-picker'], queryFn: () => listImageAssets({ limit: 50 }) });

  const resolvePreview = useMutation({
    mutationFn: () =>
      resolveImageGeneration({
        prompt,
        model_id: modelId === '' ? undefined : modelId,
        aspect_ratio: aspectRatio,
        resolution,
        output_count: outputCount,
        prompt_refs: promptRefs.map((reference) => reference.id),
        input_image_refs: imageRefs.map((reference) => reference.id),
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
        input_image_refs: imageRefs.map((reference) => reference.id),
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

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      const mime = file.type === 'image/jpeg' ? 'image/jpeg' : file.type === 'image/webp' ? 'image/webp' : 'image/png';
      return uploadAsset({ name: file.name, base64, mime });
    },
    onSuccess: (asset) => {
      toast.success(t('image.generate.uploadedToast', { name: asset.name }));
      queryClient.invalidateQueries({ queryKey: ['image-assets-picker'] });
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

  const addPromptRef = (entry: { readonly id: string; readonly name: string }) =>
    setPromptRefs((current) =>
      current.some((reference) => reference.id === entry.id)
        ? current
        : [...current, { id: entry.id, label: entry.name }],
    );
  const addImageRef = (entry: { readonly id: string; readonly name: string }) =>
    setImageRefs((current) =>
      current.some((reference) => reference.id === entry.id)
        ? current
        : [...current, { id: entry.id, label: entry.name }],
    );

  return (
    <div>
      <ListPageHeader title={t('image.generate.title')} />
      <div
        className={css({
          display: 'grid',
          gap: '6',
          alignItems: 'start',
          '@media (min-width: 1024px)': { gridTemplateColumns: 'minmax(0, 1fr) 360px' },
        })}
      >
        <Card>
          <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
            <Field label={t('image.generate.promptLabel')}>
              <MarkdownInput
                value={prompt}
                onChange={setPrompt}
                placeholder={t('image.generate.promptPlaceholder', {
                  promptRef: '{{prompt:…}}',
                  imageRef: '{{image:…}}',
                })}
              />
            </Field>
            <div
              className={css({
                containerType: 'inline-size',
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
                  options={ASPECT_RATIOS.map((value) => ({ value, label: value }))}
                />
              </Field>
              <Field label={t('image.generate.quality')}>
                <Select
                  value={resolution}
                  onChange={(event) => setResolution(event.target.value)}
                  options={RESOLUTIONS.map((value) => ({ value, label: value }))}
                />
              </Field>
              <Field label={t('image.generate.count')}>
                <Input
                  type="number"
                  min={1}
                  max={4}
                  value={outputCount}
                  onChange={(event) => setOutputCount(Math.min(4, Math.max(1, Number(event.target.value) || 1)))}
                />
              </Field>
            </div>
            <SelectedRefs
              title={t('image.generate.selectedPromptRefs')}
              refs={promptRefs}
              onRemove={(id) => setPromptRefs((current) => current.filter((entry) => entry.id !== id))}
            />
            <SelectedRefs
              title={t('image.generate.selectedImageRefs')}
              refs={imageRefs}
              onRemove={(id) => setImageRefs((current) => current.filter((entry) => entry.id !== id))}
            />
            <div
              className={css({ display: 'grid', gap: '4', md: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } })}
            >
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
              </div>
              <div className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
                <h3 className={css({ margin: '0', textStyle: 'label' })}>{t('image.generate.referenceImages')}</h3>
                <div className={css({ display: 'flex', flexWrap: 'wrap', gap: '2' })}>
                  {assets.data?.items.slice(0, 8).map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      title={t('image.generate.addAssetRef', { name: entry.name })}
                      aria-label={t('image.generate.addAssetRef', { name: entry.name })}
                      className={css({
                        padding: '0',
                        border: 'none',
                        bg: 'transparent',
                        borderRadius: 'lg',
                        cursor: 'pointer',
                        transitionProperty: 'outline-color',
                        transitionDuration: 'fast',
                        outline: '2px solid transparent',
                        outlineOffset: '2px',
                        _hover: { outlineColor: 'action' },
                        _focusVisible: { outlineColor: 'focus-ring' },
                      })}
                      onClick={() => addImageRef(entry)}
                    >
                      <img
                        src={imageUrl(entry.id)}
                        alt={entry.name}
                        className={css({
                          display: 'block',
                          bg: 'surface-muted',
                          height: 'control-lg',
                          width: 'control-lg',
                          borderRadius: 'lg',
                          objectFit: 'cover',
                        })}
                      />
                    </button>
                  ))}
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file !== undefined) {
                      upload.mutate(file);
                      event.target.value = '';
                    }
                  }}
                />
                <Button
                  variant="outline"
                  color="secondary"
                  iconStart={<UploadIcon />}
                  className={css({ alignSelf: 'flex-start' })}
                  loading={upload.isPending}
                  loadingLabel={t('common.uploading')}
                  onClick={() => fileInput.current?.click()}
                >
                  {t('image.generate.uploadReference')}
                </Button>
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
