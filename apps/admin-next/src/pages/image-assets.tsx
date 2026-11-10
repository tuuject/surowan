import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ColumnSpec,
  ConfirmDialog,
  ListFooter,
  ListPageHeader,
  ListToolbar,
  TableShell,
  useOffsetPagination,
} from '@/components/business';
import { MarkdownInput } from '@/components/prompts/markdown-input';
import type { ImageAssetInfo, ImagePromptAsset } from '@/lib/api/images.ts';
import {
  archiveImageAsset,
  archiveImagePrompt,
  createImagePrompt,
  imageUrl,
  listImageAssets,
  listImagePrompts,
  uploadImageAsset as uploadAsset,
} from '@/lib/api/images.ts';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { toast } from '@/lib/toast.ts';

/** Asset management: prompt templates and reference images, with upload and archive. */

/**
 * Stays mounted and is driven by `open`, so Base UI can play both transitions.
 * The draft is replaced on the open edge, never on close: what was typed stays
 * on screen through the exit fade.
 */
function PromptEditor({ open, onDone }: { readonly open: boolean; readonly onDone: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setName('');
      setBody('');
    }
  }
  const create = useMutation({
    mutationFn: () => createImagePrompt({ name, body }),
    onSuccess: () => {
      toast.success(t('image.assets.createdToast'));
      onDone();
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && !create.isPending && onDone()}
      title={t('image.assets.newAsset')}
      description={t('image.assets.bodyPlaceholder')}
      footer={
        <>
          <Button variant="ghost" color="secondary" onClick={onDone} disabled={create.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || name.trim() === '' || body.trim() === ''}
          >
            {create.isPending ? t('common.submitting') : t('common.create')}
          </Button>
        </>
      }
    >
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('image.assets.namePlaceholder')}
          aria-label={t('image.assets.namePlaceholder')}
        />
        <MarkdownInput
          value={body}
          onChange={setBody}
          minHeight="112px"
          placeholder={t('image.assets.bodyPlaceholder')}
          aria-label={t('image.assets.bodyPlaceholder')}
        />
      </div>
    </Dialog>
  );
}

export default function ImageAssetsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'prompts' | 'images'>('prompts');
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<{ kind: 'prompt' | 'image'; id: string; name: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const promptPagination = useOffsetPagination('prompts');
  const assetPagination = useOffsetPagination('images');
  const prompts = useQuery({
    queryKey: ['image-assets', 'prompts', promptPagination.pageSize, promptPagination.offset],
    queryFn: () => listImagePrompts({ limit: promptPagination.pageSize, offset: promptPagination.offset }),
    placeholderData: (previous) => previous,
  });
  const assets = useQuery({
    queryKey: ['image-assets', 'images', assetPagination.pageSize, assetPagination.offset],
    queryFn: () => listImageAssets({ limit: assetPagination.pageSize, offset: assetPagination.offset }),
    placeholderData: (previous) => previous,
  });
  const promptPageCount = promptPagination.pageCount(prompts.data?.total);
  const assetPageCount = assetPagination.pageCount(assets.data?.total);
  useEffect(() => {
    if (prompts.data !== undefined && !prompts.isPlaceholderData && promptPagination.page > promptPageCount) {
      promptPagination.onPageChange(promptPageCount);
    }
  }, [promptPageCount, promptPagination, prompts.data, prompts.isPlaceholderData]);
  useEffect(() => {
    if (assets.data !== undefined && !assets.isPlaceholderData && assetPagination.page > assetPageCount) {
      assetPagination.onPageChange(assetPageCount);
    }
  }, [assetPageCount, assetPagination, assets.data, assets.isPlaceholderData]);

  const archive = useMutation({
    mutationFn: async () => {
      if (archiving === null) {
        return;
      }
      return archiving.kind === 'prompt' ? archiveImagePrompt(archiving.id) : archiveImageAsset(archiving.id);
    },
    onSuccess: () => {
      toast.success(t('image.assets.archivedToast'));
      setArchiving(null);
      queryClient.invalidateQueries({ queryKey: ['image-assets'] });
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const buffer = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      const base64 = btoa(binary);
      const mime = file.type === 'image/jpeg' ? 'image/jpeg' : file.type === 'image/webp' ? 'image/webp' : 'image/png';
      return uploadAsset({ name: file.name, base64, mime });
    },
    onSuccess: () => {
      toast.success(t('image.assets.uploadedToast'));
      queryClient.invalidateQueries({ queryKey: ['image-assets'] });
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  const promptColumns: readonly ColumnSpec<ImagePromptAsset>[] = [
    {
      key: 'name',
      title: t('image.assets.columnName'),
      render: (row) => <span className={css({ textStyle: 'label' })}>{row.name}</span>,
    },
    { key: 'category', title: t('image.assets.columnCategory'), render: (row) => row.category },
    { key: 'updated', title: t('image.assets.columnUpdated'), render: (row) => formatTime(row.updated_at) },
    {
      key: 'actions',
      title: t('pages.apiKeys.actions'),
      align: 'right',
      render: (row) => (
        <Button
          size="sm"
          variant="ghost"
          color="secondary"
          onClick={() => setArchiving({ kind: 'prompt', id: row.id, name: row.name })}
        >
          {t('image.assets.archive')}
        </Button>
      ),
    },
  ];
  const assetColumns: readonly ColumnSpec<ImageAssetInfo>[] = [
    {
      key: 'preview',
      title: t('image.assets.columnPreview'),
      render: (row) => (
        <img
          src={imageUrl(row.id)}
          alt={row.name}
          className={css({
            bg: 'surface-muted',
            height: '40px',
            width: '40px',
            borderRadius: 'lg',
            objectFit: 'cover',
          })}
        />
      ),
    },
    {
      key: 'name',
      title: t('image.assets.columnName'),
      render: (row) => <span className={css({ textStyle: 'label' })}>{row.name}</span>,
    },
    { key: 'source', title: t('image.assets.columnSource'), render: (row) => row.source },
    { key: 'created', title: t('image.assets.columnCreated'), render: (row) => formatTime(row.created_at) },
    {
      key: 'actions',
      title: t('pages.apiKeys.actions'),
      align: 'right',
      render: (row) => (
        <Button
          size="sm"
          variant="ghost"
          color="secondary"
          onClick={() => setArchiving({ kind: 'image', id: row.id, name: row.name })}
        >
          {t('image.assets.archive')}
        </Button>
      ),
    },
  ];

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <ListPageHeader title={t('image.assets.title')} />
      <ListToolbar
        trailing={
          <div className={css({ display: 'flex', gap: '1' })}>
            <Button
              variant={tab === 'prompts' ? 'soft' : 'ghost'}
              color="secondary"
              aria-pressed={tab === 'prompts'}
              onClick={() => setTab('prompts')}
            >
              {t('image.assets.tabPrompts')}
            </Button>
            <Button
              variant={tab === 'images' ? 'soft' : 'ghost'}
              color="secondary"
              aria-pressed={tab === 'images'}
              onClick={() => setTab('images')}
            >
              {t('image.assets.tabImages')}
            </Button>
          </div>
        }
        onRefresh={() => void (tab === 'prompts' ? prompts.refetch() : assets.refetch())}
        refreshing={tab === 'prompts' ? prompts.isRefetching : assets.isRefetching}
      >
        {tab === 'images' ? (
          <>
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
              variant="outline"
              color="secondary"
              onClick={() => fileInput.current?.click()}
              disabled={upload.isPending}
            >
              {upload.isPending ? t('common.uploading') : t('image.assets.uploadImage')}
            </Button>
          </>
        ) : (
          <Button variant="outline" color="secondary" onClick={() => setCreating(true)}>
            {t('image.assets.newAsset')}
          </Button>
        )}
      </ListToolbar>

      <PromptEditor
        open={creating && tab === 'prompts'}
        onDone={() => {
          setCreating(false);
          queryClient.invalidateQueries({ queryKey: ['image-assets'] });
        }}
      />

      {tab === 'prompts' && prompts.isError ? (
        <p role="alert" className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
          {errorMessage(prompts.error)}
        </p>
      ) : null}
      {tab === 'images' && assets.isError ? (
        <p role="alert" className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
          {errorMessage(assets.error)}
        </p>
      ) : null}
      <div>
        {tab === 'prompts' ? (
          prompts.isPending || prompts.data !== undefined ? (
            <>
              <TableShell
                columns={promptColumns}
                data={prompts.data?.items ?? []}
                rowKey={(row) => row.id}
                loading={prompts.isPending || prompts.isPlaceholderData}
                emptyText={t('image.assets.emptyPrompts')}
              />
              <ListFooter
                count={prompts.data?.total ?? 0}
                page={promptPagination.page}
                pageCount={promptPageCount}
                busy={prompts.isPlaceholderData}
                onPageChange={promptPagination.onPageChange}
              />
            </>
          ) : null
        ) : assets.isPending || assets.data !== undefined ? (
          <>
            <TableShell
              columns={assetColumns}
              data={assets.data?.items ?? []}
              rowKey={(row) => row.id}
              loading={assets.isPending || assets.isPlaceholderData}
              emptyText={t('image.assets.emptyImages')}
            />
            <ListFooter
              count={assets.data?.total ?? 0}
              page={assetPagination.page}
              pageCount={assetPageCount}
              busy={assets.isPlaceholderData}
              onPageChange={assetPagination.onPageChange}
            />
          </>
        ) : null}
      </div>

      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => {
          if (!open) {
            setArchiving(null);
          }
        }}
        title={archiving === null ? '' : t('image.assets.archiveConfirmTitle', { name: archiving.name })}
        description={t('image.assets.archiveConfirmDescription')}
        confirmText={t('image.assets.archive')}
        pending={archive.isPending}
        error={archive.isError ? errorMessage(archive.error) : null}
        onConfirm={() => archive.mutate()}
      />
    </div>
  );
}
