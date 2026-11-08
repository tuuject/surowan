import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { ImageModelConfig } from '@/lib/api/images.ts';

/** Read-only summary of what one endpoint accepts and returns. */
export function ModelCapabilities({
  capabilities,
}: {
  readonly capabilities: ImageModelConfig['capabilities'];
}): ReactElement {
  const { t } = useTranslation();
  const qualityNames: Record<string, string> = {
    auto: t('image.settings.enumAuto'),
    low: t('image.settings.enumLow'),
    medium: t('image.settings.enumMedium'),
    high: t('image.settings.enumHigh'),
  };
  return (
    // Inline meta keeps its items apart with a layout gap rather than a separator glyph.
    <div className={css({ textStyle: 'small', color: 'text-muted' })}>
      <p className={css({ margin: '0', display: 'flex', flexWrap: 'wrap', columnGap: '3', rowGap: '1' })}>
        <span>
          {capabilities.imageInput
            ? t('image.settings.capabilitiesInput', { count: capabilities.maxInputImages })
            : t('image.settings.capabilitiesTextOnly')}
        </span>
        <span>{t('image.settings.capabilitiesOutputs', { count: capabilities.maxOutputs })}</span>
      </p>
      <p className={css({ margin: '0', display: 'flex', flexWrap: 'wrap', columnGap: '3', rowGap: '1' })}>
        <span>
          {t('image.settings.aspectRatiosLabel', {
            values: capabilities.aspectRatios
              .map((value) => (value === 'auto' ? t('image.settings.enumAuto') : value))
              .join('、'),
          })}
        </span>
        <span>
          {t('image.settings.qualityLabel', {
            values: capabilities.resolutionClasses.map((value) => qualityNames[value] ?? value).join('、'),
          })}
        </span>
      </p>
    </div>
  );
}
