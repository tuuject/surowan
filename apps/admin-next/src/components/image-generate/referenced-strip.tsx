import { useQuery } from '@tanstack/react-query';
import { css } from '@tuuject/koi-react/styled-system/css';
import { CloseIcon } from '@tuuject/koi-react/icons';
import { useTranslation } from 'react-i18next';
import { getImageAsset, imageUrl } from '@/lib/api/images.ts';
import { referencedAssetIds } from './prompt-refs.ts';

/**
 * The referenced-image strip, derived from the prompt text alone: one entry per
 * distinct referenced asset, in order of first appearance, with the number the
 * image model will see (`图 N`). Removing an entry removes every token of that
 * asset from the text, so the text stays the single source of truth.
 */
export function ReferencedStrip({
  prompt,
  onRemove,
}: {
  readonly prompt: string;
  readonly onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  const ids = referencedAssetIds(prompt);
  if (ids.length === 0) {
    return null;
  }
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
      <h3 className={css({ margin: '0', textStyle: 'label' })}>{t('image.generate.referencedImages')}</h3>
      <ul
        aria-label={t('image.generate.referencedImages')}
        className={css({ display: 'flex', flexWrap: 'wrap', gap: '2', margin: '0', padding: '0', listStyle: 'none' })}
      >
        {ids.map((id, index) => (
          <ReferencedEntry key={id} id={id} ordinal={index + 1} onRemove={onRemove} />
        ))}
      </ul>
    </div>
  );
}

function ReferencedEntry({
  id,
  ordinal,
  onRemove,
}: {
  readonly id: string;
  readonly ordinal: number;
  readonly onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  const asset = useQuery({
    queryKey: ['image-asset', id],
    queryFn: () => getImageAsset(id),
    retry: false,
    staleTime: 30_000,
  });
  // The metadata loads per entry: a loading line first, and the "missing"
  // label only once the lookup actually failed.
  const title = asset.isError
    ? t('image.generate.referencedMissing')
    : (asset.data?.name ?? t('image.generate.referencedLoading'));
  return (
    <li
      className={css({
        display: 'flex',
        alignItems: 'center',
        gap: '2',
        borderWidth: '1px',
        borderColor: 'border',
        borderRadius: 'lg',
        padding: '2',
      })}
    >
      <img
        src={imageUrl(id)}
        alt={title}
        className={css({
          bg: 'surface-muted',
          height: 'control-lg',
          width: 'control-lg',
          borderRadius: 'lg',
          objectFit: 'cover',
        })}
      />
      <div className={css({ display: 'flex', flexDirection: 'column', minWidth: '0' })}>
        <span className={css({ textStyle: 'label', truncate: true })}>{title}</span>
        <span className={css({ textStyle: 'small', color: 'text-muted' })}>
          {t('image.generate.referencedOrdinal', { ordinal })}
        </span>
      </div>
      <button
        type="button"
        aria-label={t('image.generate.removeReference', { name: title })}
        className={css({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 'control-sm',
          width: 'control-sm',
          padding: '0',
          border: 'none',
          bg: 'transparent',
          color: 'text-muted',
          borderRadius: 'lg',
          cursor: 'pointer',
          transitionProperty: 'outline-color',
          transitionDuration: 'fast',
          outline: '2px solid transparent',
          outlineOffset: '2px',
          _hover: { outlineColor: 'action', color: 'text' },
          _focusVisible: { outlineColor: 'focus-ring' },
        })}
        onClick={() => onRemove(id)}
      >
        <CloseIcon />
      </button>
    </li>
  );
}
