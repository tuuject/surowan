import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ModelCapabilities } from './model-capabilities.tsx';
import type { EditableModel } from './shared.ts';

/**
 * The models that will be saved: one row each with its description override and a read-only capability summary.
 * `mergedDuplicates` counts entries the server sent more than once and the form collapsed.
 */
export function ModelList({
  models,
  setModels,
  mergedDuplicates,
}: {
  readonly models: readonly EditableModel[];
  readonly setModels: React.Dispatch<React.SetStateAction<EditableModel[]>>;
  readonly mergedDuplicates: number;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <>
      {mergedDuplicates > 0 && (
        <p className="text-muted-foreground text-sm">
          {t('image.settings.mergedDuplicates', { count: mergedDuplicates })}
        </p>
      )}
      {models.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('image.settings.noModelsYet')}</p>
      ) : (
        <ul className="space-y-5">
          {models.map((model) => (
            <li key={model.key} className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium">{model.name}</p>
                  <p className="text-muted-foreground break-all text-xs">
                    {model.upstreamModel} · {model.providerTag} ·{' '}
                    {t('image.settings.credentialRef', { name: model.credentialRef })}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('image.settings.removeModel', { name: model.name })}
                  onClick={() => setModels((current) => current.filter((item) => item !== model))}
                >
                  {t('image.settings.remove')}
                </Button>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`model-description-${model.key}`}>{t('image.settings.modelDescriptionLabel')}</Label>
                <Textarea
                  id={`model-description-${model.key}`}
                  rows={2}
                  maxLength={1000}
                  value={model.description}
                  placeholder={t('image.settings.modelDescriptionPlaceholder')}
                  onChange={(event) =>
                    setModels((current) =>
                      current.map((item) =>
                        item.key === model.key ? { ...item, description: event.target.value } : item,
                      ),
                    )
                  }
                />
                <p className="text-muted-foreground text-xs">{t('image.settings.modelDescriptionHint')}</p>
              </div>
              <ModelCapabilities capabilities={model.capabilities} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
