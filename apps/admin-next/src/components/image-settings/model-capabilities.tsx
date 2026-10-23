import type React from 'react';
import { useTranslation } from 'react-i18next';
import type { ImageModelConfig } from '@/lib/api/images.ts';

/** Read-only summary of what one endpoint accepts and returns. */
export function ModelCapabilities({
  capabilities,
}: {
  readonly capabilities: ImageModelConfig['capabilities'];
}): React.ReactElement {
  const { t } = useTranslation();
  const qualityNames: Record<string, string> = {
    auto: t('image.settings.enumAuto'),
    low: t('image.settings.enumLow'),
    medium: t('image.settings.enumMedium'),
    high: t('image.settings.enumHigh'),
  };
  return (
    <p className="text-muted-foreground text-xs leading-relaxed">
      {capabilities.imageInput
        ? t('image.settings.capabilitiesInput', { count: capabilities.maxInputImages })
        : t('image.settings.capabilitiesTextOnly')}{' '}
      · {t('image.settings.capabilitiesOutputs', { count: capabilities.maxOutputs })}
      <br />
      {t('image.settings.aspectRatiosLabel', {
        values: capabilities.aspectRatios
          .map((value) => (value === 'auto' ? t('image.settings.enumAuto') : value))
          .join('、'),
      })}
      {' · '}
      {t('image.settings.qualityLabel', {
        values: capabilities.resolutionClasses.map((value) => qualityNames[value] ?? value).join('、'),
      })}
    </p>
  );
}
