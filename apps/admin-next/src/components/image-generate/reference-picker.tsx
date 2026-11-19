import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { SearchIcon, UploadIcon } from '@tuuject/koi-react/icons';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListFooter, useOffsetPagination } from '@/components/business';
import type { ImageAssetInfo } from '@/lib/api/images.ts';
import { imageUrl, listImageAssets, uploadImageAsset } from '@/lib/api/images.ts';
import { errorMessage } from '@/lib/errors';
import { toast } from '@/lib/toast.ts';

/**
 * The reference-image picker of the generate page: a short strip of the newest
 * assets plus a "More" dialog that searches and pages the whole non-archived
 * library. Picking anywhere (strip, dialog, or a fresh upload) hands the asset
 * to the page, which inserts its token into the prompt at the caret.
 *
 * Every list reads the shared `['image-assets', …]` cache, so edits, archives
 * and uploads anywhere (this page or the assets page) refresh the strip and the
 * dialog together with the per-asset `['image-asset', id]` lookups.
 */

const RECENT_COUNT = 8;
const DIALOG_PAGE_SIZE = 12;

export interface PickedAsset {
  readonly id: string;
  readonly name: string;
}

export function ReferencePicker({ onPick }: { readonly onPick: (asset: PickedAsset) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [moreOpen, setMoreOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const recent = useQuery({
    queryKey: ['image-assets', 'picker'],
    queryFn: () => listImageAssets({ limit: RECENT_COUNT }),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      const base64 = btoa(binary);
      const mime = file.type === 'image/jpeg' ? 'image/jpeg' : file.type === 'image/webp' ? 'image/webp' : 'image/png';
      return uploadImageAsset({ name: file.name, base64, mime });
    },
    onSuccess: (asset) => {
      toast.success(t('image.generate.uploadedToast', { name: asset.name }));
      queryClient.invalidateQueries({ queryKey: ['image-assets'] });
      queryClient.invalidateQueries({ queryKey: ['image-asset'] });
      onPick(asset);
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  const pick = (asset: PickedAsset) => {
    onPick(asset);
    setMoreOpen(false);
  };

  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
      <h3 className={css({ margin: '0', textStyle: 'label' })}>{t('image.generate.referenceImages')}</h3>
      <div className={css({ display: 'flex', flexWrap: 'wrap', gap: '2' })}>
        {recent.data?.items.slice(0, RECENT_COUNT).map((asset) => (
          <RecentThumb key={asset.id} asset={asset} onPick={pick} />
        ))}
        <Button variant="outline" color="secondary" iconStart={<SearchIcon />} onClick={() => setMoreOpen(true)}>
          {t('image.generate.moreAssets')}
        </Button>
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
          loading={upload.isPending}
          loadingLabel={t('common.uploading')}
          onClick={() => fileInput.current?.click()}
        >
          {t('image.generate.uploadReference')}
        </Button>
      </div>
      {recent.isError ? (
        <p
          role="alert"
          className={css({ margin: '0', textStyle: 'small', color: 'error-text', overflowWrap: 'anywhere' })}
        >
          {errorMessage(recent.error)}
        </p>
      ) : null}
      <LibraryDialog open={moreOpen} onDone={() => setMoreOpen(false)} onPick={pick} />
    </div>
  );
}

function RecentThumb({
  asset,
  onPick,
}: {
  readonly asset: ImageAssetInfo;
  readonly onPick: (asset: PickedAsset) => void;
}) {
  const { t } = useTranslation();
  const label = t('image.generate.addAssetRef', { name: asset.name });
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
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
      onClick={() => onPick(asset)}
    >
      <img
        src={imageUrl(asset.id)}
        alt={asset.name}
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
  );
}

function LibraryDialog({
  open,
  onDone,
  onPick,
}: {
  readonly open: boolean;
  readonly onDone: () => void;
  readonly onPick: (asset: PickedAsset) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [wasOpen, setWasOpen] = useState(open);
  // Seeded on the open edge, kept through the exit fade: a reopening starts a
  // fresh search from page 1, never the page the last visit ended on.
  const pagination = useOffsetPagination('image-library', DIALOG_PAGE_SIZE);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setDraft('');
      setSearch('');
      pagination.onPageChange(1);
    }
  }
  // The library is only fetched while the dialog is actually open.
  const library = useQuery({
    queryKey: ['image-assets', 'library', search, pagination.pageSize, pagination.offset],
    queryFn: () => listImageAssets({ q: search, limit: pagination.pageSize, offset: pagination.offset }),
    placeholderData: (previous) => previous,
    enabled: open,
  });
  const pageCount = pagination.pageCount(library.data?.total);
  const applySearch = () => {
    setSearch(draft.trim());
    pagination.onPageChange(1);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onDone()}
      title={t('image.generate.libraryTitle')}
      description={t('image.generate.libraryDescription')}
      size="lg"
      footer={
        <Button variant="ghost" color="secondary" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      }
    >
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
        <form
          className={css({ display: 'flex', gap: '2' })}
          onSubmit={(event) => {
            event.preventDefault();
            applySearch();
          }}
        >
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t('image.generate.librarySearchPlaceholder')}
            aria-label={t('image.generate.librarySearchPlaceholder')}
            dir="auto"
          />
          <Button type="submit" iconStart={<SearchIcon />} className={css({ flexShrink: '0' })}>
            {t('layout.koi.search')}
          </Button>
        </form>
        <div
          className={css({
            display: 'grid',
            gap: '2',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            md: { gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' },
          })}
        >
          {library.data?.items.map((asset) => (
            <button
              key={asset.id}
              type="button"
              title={t('image.generate.addAssetRef', { name: asset.name })}
              className={css({
                display: 'flex',
                flexDirection: 'column',
                gap: '1',
                padding: '0',
                border: 'none',
                bg: 'transparent',
                cursor: 'pointer',
                textAlign: 'start',
                transitionProperty: 'outline-color',
                transitionDuration: 'fast',
                outline: '2px solid transparent',
                outlineOffset: '2px',
                _hover: { outlineColor: 'action' },
                _focusVisible: { outlineColor: 'focus-ring' },
              })}
              onClick={() => onPick(asset)}
            >
              <img
                src={imageUrl(asset.id)}
                alt=""
                className={css({
                  display: 'block',
                  bg: 'surface-muted',
                  aspectRatio: 'square',
                  width: '100%',
                  borderRadius: 'lg',
                  objectFit: 'cover',
                })}
              />
              <span className={css({ textStyle: 'small', color: 'text-muted', truncate: true })}>{asset.name}</span>
            </button>
          ))}
        </div>
        {library.isPending && library.data === undefined ? (
          <p className={css({ margin: '0', color: 'text-muted' })}>{t('image.generate.libraryLoading')}</p>
        ) : null}
        {library.isError ? (
          <p role="alert" className={css({ margin: '0', color: 'error-text', overflowWrap: 'anywhere' })}>
            {errorMessage(library.error)}
          </p>
        ) : null}
        <ListFooter
          count={library.data?.total ?? 0}
          page={pagination.page}
          pageCount={pageCount}
          busy={library.isPlaceholderData}
          onPageChange={pagination.onPageChange}
        />
      </div>
    </Dialog>
  );
}
