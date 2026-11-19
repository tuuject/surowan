import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Badge } from '@tuuject/koi-react/badge';
import { Button } from '@tuuject/koi-react/button';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AssetEditDialog } from '@/components/image-assets/asset-edit-dialog.tsx';
import { PromptCreateDialog, PromptRenameDialog } from '@/components/image-assets/prompt-dialogs.tsx';
import {
  type ColumnSpec,
  ConfirmDialog,
  ListFooter,
  ListPageHeader,
  ListToolbar,
  RowActions,
  TableShell,
  TimeText,
  useOffsetPagination,
} from '@/components/business';
import { AppLink } from '@/components/router-links';
import type { ImageAssetInfo, ImagePromptAsset } from '@/lib/api/images.ts';
import {
  archiveImageAsset,
  archiveImagePrompt,
  getImageStatus,
  imageUrl,
  listImageAssets,
  listImagePrompts,
  uploadImageAsset as uploadAsset,
} from '@/lib/api/images.ts';
import { errorMessage } from '@/lib/errors';
import { toast } from '@/lib/toast.ts';

/** Asset management: prompt templates and reference images, with upload and archive. */

type AssetTarget = { readonly kind: 'prompt' | 'image'; readonly id: string; readonly name: string };

export default function ImageAssetsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'prompts' | 'images'>('prompts');
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<{ readonly id: string; readonly name: string } | null>(null);
  const [editing, setEditing] = useState<ImageAssetInfo | null>(null);
  const [archiving, setArchiving] = useState<AssetTarget | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const promptPagination = useOffsetPagination('prompts');
  const assetPagination = useOffsetPagination('images');
  const status = useQuery({ queryKey: ['image-status'], queryFn: getImageStatus, staleTime: 10_000 });
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
      queryClient.invalidateQueries({ queryKey: ['image-asset'] });
      queryClient.invalidateQueries({ queryKey: ['image-prompts-picker'] });
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
    { key: 'updated', title: t('image.assets.columnUpdated'), render: (row) => <TimeText value={row.updatedAt} /> },
    {
      key: 'actions',
      title: t('pages.apiKeys.actions'),
      align: 'right',
      paddingBlock: 'none',
      render: (row) => (
        <RowActions>
          <Button
            size="sm"
            variant="ghost"
            color="secondary"
            onClick={() => setRenaming({ id: row.id, name: row.name })}
          >
            {t('image.assets.rename')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            color="secondary"
            onClick={() => setArchiving({ kind: 'prompt', id: row.id, name: row.name })}
          >
            {t('image.assets.archive')}
          </Button>
        </RowActions>
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
    {
      key: 'keywords',
      title: t('image.assets.columnKeywords'),
      render: (row) => (
        <span className={css({ color: row.keywords.length === 0 ? 'text-muted' : 'text', truncate: true })}>
          {row.keywords.length === 0 ? t('image.assets.keywordsEmpty') : row.keywords}
        </span>
      ),
    },
    {
      key: 'agentVisible',
      title: t('image.assets.columnAgentVisible'),
      render: (row) =>
        row.agentVisible ? (
          <Badge tone="primary">{t('image.assets.visibilityUsable')}</Badge>
        ) : (
          <Badge>{t('image.assets.visibilityPrivate')}</Badge>
        ),
    },
    { key: 'source', title: t('image.assets.columnSource'), render: (row) => row.source },
    { key: 'created', title: t('image.assets.columnCreated'), render: (row) => <TimeText value={row.createdAt} /> },
    {
      key: 'actions',
      title: t('pages.apiKeys.actions'),
      align: 'right',
      paddingBlock: 'none',
      render: (row) => (
        <RowActions>
          <Button size="sm" variant="ghost" color="secondary" onClick={() => setEditing(row)}>
            {t('image.assets.edit')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            color="secondary"
            onClick={() => setArchiving({ kind: 'image', id: row.id, name: row.name })}
          >
            {t('image.assets.archive')}
          </Button>
        </RowActions>
      ),
    },
  ];

  if (status.data !== undefined && !status.data.enabled) {
    return (
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
        <ListPageHeader title={t('image.assets.title')} />
        <Alert tone="info">
          {t('image.generate.disabledIntro')}
          <AppLink to="/image-settings">{t('image.generate.disabledLink')}</AppLink>
        </Alert>
      </div>
    );
  }

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

      <PromptCreateDialog
        open={creating && tab === 'prompts'}
        onDone={() => {
          setCreating(false);
          // The page's own prompt table lives under the shared assets root;
          // the generate page's picker has its own key.
          queryClient.invalidateQueries({ queryKey: ['image-assets'] });
          queryClient.invalidateQueries({ queryKey: ['image-prompts-picker'] });
        }}
      />

      <PromptRenameDialog
        target={renaming}
        onDone={() => {
          setRenaming(null);
          queryClient.invalidateQueries({ queryKey: ['image-assets'] });
          queryClient.invalidateQueries({ queryKey: ['image-prompts-picker'] });
        }}
      />

      <AssetEditDialog
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          queryClient.invalidateQueries({ queryKey: ['image-assets'] });
          queryClient.invalidateQueries({ queryKey: ['image-asset'] });
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
        {tab === 'prompts' && (prompts.isPending || prompts.data !== undefined) ? (
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
        ) : null}
        {tab === 'images' && (assets.isPending || assets.data !== undefined) ? (
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
