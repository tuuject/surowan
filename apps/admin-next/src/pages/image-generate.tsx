import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@tuuject/koi-react/button';
import { Input } from '@tuuject/koi-react/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@tuuject/koi-react/textarea';
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
import { css } from '@tuuject/koi-react/styled-system/css';

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
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
      <div className={css({ textStyle: 'small', color: 'text-muted' })}>{title}</div>
      <div className={css({ display: 'flex', flexWrap: 'wrap', gap: '2' })}>
        {refs.map((reference) => (
          <button
            key={reference.id}
            type="button"
            onClick={() => onRemove(reference.id)}
            className={css({
              textStyle: 'small',
              bg: 'surface-muted',
              borderRadius: 'lg',
              paddingInline: '2',
              paddingBlock: '1',
              _hover: { bg: 'surface-muted' },
            })}
          >
            {reference.label} ✕
          </button>
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
              borderRadius: 'lg',
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
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
        <h1 className={css({ textStyle: 'heading-2' })}>{t('image.generate.title')}</h1>
        <p className={css({ textStyle: 'body', color: 'text-muted' })}>
          {t('image.generate.disabledIntro')}
          <Link to="/image-settings" className={css({ textDecorationLine: 'underline' })}>
            {t('image.generate.disabledLink')}
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div
      className={css({
        display: 'grid',
        gap: '4',
        '@media (min-width: 1024px)': { gridTemplateColumns: 'minmax(0,1fr) 360px' },
      })}
    >
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
          <Label htmlFor="image-prompt">{t('image.generate.promptLabel')}</Label>
          <Textarea
            id="image-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={6}
            placeholder={t('image.generate.promptPlaceholder', {
              promptRef: '{{prompt:…}}',
              imageRef: '{{image:…}}',
            })}
          />
        </div>
        <div
          className={css({
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: '3',
            md: { gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' },
          })}
        >
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
            <Label>{t('image.generate.model')}</Label>
            <select
              className={css({
                textStyle: 'body',
                borderColor: 'border',
                bg: 'surface',
                width: '100%',
                borderRadius: 'lg',
                borderWidth: '1px',
                paddingInline: '2',
                paddingBlock: '2',
              })}
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
            >
              <option value="">{t('image.generate.defaultModelOption')}</option>
              {status.data?.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </div>
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
            <Label>{t('image.generate.aspectRatio')}</Label>
            <select
              className={css({
                textStyle: 'body',
                borderColor: 'border',
                bg: 'surface',
                width: '100%',
                borderRadius: 'lg',
                borderWidth: '1px',
                paddingInline: '2',
                paddingBlock: '2',
              })}
              value={aspectRatio}
              onChange={(event) => setAspectRatio(event.target.value)}
            >
              {ASPECT_RATIOS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
            <Label>{t('image.generate.quality')}</Label>
            <select
              className={css({
                textStyle: 'body',
                borderColor: 'border',
                bg: 'surface',
                width: '100%',
                borderRadius: 'lg',
                borderWidth: '1px',
                paddingInline: '2',
                paddingBlock: '2',
              })}
              value={resolution}
              onChange={(event) => setResolution(event.target.value)}
            >
              {RESOLUTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
            <Label>{t('image.generate.count')}</Label>
            <Input
              type="number"
              min={1}
              max={4}
              value={outputCount}
              onChange={(event) => setOutputCount(Math.min(4, Math.max(1, Number(event.target.value) || 1)))}
            />
          </div>
        </div>
        <div
          className={css({
            '& > :not(:last-child)': { marginBlockEnd: '3' },
            borderRadius: 'lg',
            borderWidth: '1px',
            borderColor: 'border',
            padding: '3',
          })}
        >
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
          <div className={css({ display: 'grid', gap: '2', md: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } })}>
            <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
              <div className={css({ textStyle: 'small', color: 'text-muted' })}>{t('image.generate.promptAssets')}</div>
              <div
                className={css({ display: 'flex', maxHeight: '112px', flexWrap: 'wrap', gap: '1', overflowY: 'auto' })}
              >
                {prompts.data?.items.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={css({
                      textStyle: 'small',
                      bg: 'surface-muted',
                      borderRadius: 'lg',
                      paddingInline: '2',
                      paddingBlock: '1',
                      _hover: { bg: 'surface-muted' },
                    })}
                    onClick={() =>
                      setPromptRefs((current) =>
                        current.some((reference) => reference.id === entry.id)
                          ? current
                          : [...current, { id: entry.id, label: entry.name }],
                      )
                    }
                  >
                    {t('image.generate.addAssetRef', { name: entry.name })}
                  </button>
                ))}
              </div>
            </div>
            <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
              <div className={css({ textStyle: 'small', color: 'text-muted' })}>
                {t('image.generate.referenceImages')}
              </div>
              <div className={css({ display: 'flex', flexWrap: 'wrap', gap: '2' })}>
                {assets.data?.items.slice(0, 8).map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    title={t('image.generate.addAssetRef', { name: entry.name })}
                    className={css({ _hover: { outline: '2px solid', outlineColor: 'action' }, borderRadius: 'lg' })}
                    onClick={() =>
                      setImageRefs((current) =>
                        current.some((reference) => reference.id === entry.id)
                          ? current
                          : [...current, { id: entry.id, label: entry.name }],
                      )
                    }
                  >
                    <img
                      src={imageUrl(entry.id)}
                      alt={entry.name}
                      className={css({
                        bg: 'surface-muted',
                        height: '40px',
                        width: '40px',
                        borderRadius: 'lg',
                        objectFit: 'cover',
                      })}
                    />
                  </button>
                ))}
              </div>
              <div>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className={css({ display: 'none' })}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file !== undefined) {
                      upload.mutate(file);
                      event.target.value = '';
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  color="secondary"
                  size="sm"
                  onClick={() => fileInput.current?.click()}
                  disabled={upload.isPending}
                >
                  {upload.isPending ? t('common.uploading') : t('image.generate.uploadReference')}
                </Button>
              </div>
            </div>
          </div>
        </div>
        <div className={css({ display: 'flex', gap: '2' })}>
          <Button type="button" onClick={() => submit.mutate()} disabled={submit.isPending || prompt.trim() === ''}>
            {submit.isPending ? t('common.submitting') : t('image.generate.generate')}
          </Button>
          <Button
            type="button"
            variant="outline"
            color="secondary"
            onClick={() => resolvePreview.mutate()}
            disabled={resolvePreview.isPending || prompt.trim() === ''}
          >
            {resolvePreview.isPending ? t('image.generate.resolving') : t('image.generate.resolvePreview')}
          </Button>
        </div>
        {resolved !== null && (
          <div
            className={css({
              bg: 'surface-muted',
              '& > :not(:last-child)': { marginBlockEnd: '1' },
              borderRadius: 'lg',
              padding: '3',
            })}
          >
            <div className={css({ textStyle: 'small', color: 'text-muted' })}>
              {t('image.generate.resolvedPromptLabel')}
            </div>
            <pre className={css({ textStyle: 'small', whiteSpace: 'pre-wrap' })}>{resolved}</pre>
          </div>
        )}
      </div>
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
        <div className={css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between' })}>
          <h2 className={css({ textStyle: 'label' })}>{t('image.generate.outputsTitle')}</h2>
          {pending !== null && (
            <Link
              to="/image-generations/$generationId"
              params={{ generationId: pending.id }}
              className={css({ textStyle: 'small', textDecorationLine: 'underline' })}
            >
              {t('image.generate.auditDetail')}
            </Link>
          )}
        </div>
        {pending === null ? (
          <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('image.generate.outputsPlaceholder')}</p>
        ) : (
          <OutputGrid generation={pending} />
        )}
      </div>
    </div>
  );
}
