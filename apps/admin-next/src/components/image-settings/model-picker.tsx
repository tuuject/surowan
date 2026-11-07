import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@tuuject/koi-react/button';
import { Input } from '@tuuject/koi-react/input';
import { Label } from '@/components/ui/label';
import type { ImageCatalogEndpoint } from '@/lib/api/images.ts';
import { ModelCapabilities } from './model-capabilities.tsx';
import { type EditableCredential, selectClass } from './shared.ts';
import { css } from '@tuuject/koi-react/styled-system/css';

/** One catalog entry from `GET /image/models`. */
type CatalogModel = { id: string; name: string };

/**
 * Search box, model select and the endpoint/provider details for the selected model. The catalog and endpoint
 * queries stay in the page so this section only renders their state.
 */
export function ModelPicker({
  catalogPending,
  catalogErrorText,
  search,
  onSearchChange,
  modelId,
  onModelChange,
  visibleModels,
  endpointsPending,
  endpointsErrorText,
  onRetryEndpoints,
  availableEndpoints,
  selectedEndpoint,
  onProviderTagChange,
  credentials,
  selectedCredential,
  onCredentialChange,
  alreadyAdded,
  canAdd,
  onAddModel,
}: {
  readonly catalogPending: boolean;
  readonly catalogErrorText: string | null;
  readonly search: string;
  readonly onSearchChange: (value: string) => void;
  readonly modelId: string;
  readonly onModelChange: (value: string) => void;
  readonly visibleModels: readonly CatalogModel[];
  readonly endpointsPending: boolean;
  readonly endpointsErrorText: string | null;
  readonly onRetryEndpoints: () => void;
  readonly availableEndpoints: readonly ImageCatalogEndpoint[];
  readonly selectedEndpoint: ImageCatalogEndpoint | undefined;
  readonly onProviderTagChange: (value: string) => void;
  readonly credentials: readonly EditableCredential[];
  readonly selectedCredential: string;
  readonly onCredentialChange: (value: string) => void;
  readonly alreadyAdded: boolean;
  readonly canAdd: boolean;
  readonly onAddModel: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('image.settings.modelsHint')}</p>
      {catalogErrorText !== null && (
        <p role="alert" className={css({ textStyle: 'body', color: 'error-text' })}>
          {t('image.settings.catalogError', { error: catalogErrorText })}
        </p>
      )}
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
        <Label htmlFor="image-model-search">{t('image.settings.searchModels')}</Label>
        <Input
          id="image-model-search"
          placeholder={t('image.settings.searchPlaceholder')}
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </div>
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
        <Label htmlFor="image-model-select">{t('image.settings.modelSelectLabel')}</Label>
        <select
          id="image-model-select"
          className={selectClass}
          value={modelId}
          disabled={catalogPending || visibleModels.length === 0}
          onChange={(event) => onModelChange(event.target.value)}
        >
          <option value="">
            {catalogPending
              ? t('image.settings.fetchingModelsOption')
              : visibleModels.length === 0
                ? t('image.settings.noMatchingModels')
                : t('image.settings.selectModelOption')}
          </option>
          {visibleModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name} ({model.id})
            </option>
          ))}
        </select>
      </div>
      {modelId && (
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
          {endpointsPending ? (
            <p role="status" className={css({ textStyle: 'body', color: 'text-muted' })}>
              {t('image.settings.readingEndpoints')}
            </p>
          ) : endpointsErrorText !== null ? (
            <div role="alert" className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
              <p className={css({ textStyle: 'body', color: 'error-text' })}>
                {t('image.settings.endpointsError', { error: endpointsErrorText })}
              </p>
              <Button size="sm" variant="outline" color="secondary" onClick={onRetryEndpoints}>
                {t('image.settings.retryProviders')}
              </Button>
            </div>
          ) : (
            <>
              <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
                <Label htmlFor="image-provider-select">{t('image.settings.provider')}</Label>
                <select
                  id="image-provider-select"
                  className={selectClass}
                  value={selectedEndpoint?.providerTag ?? ''}
                  onChange={(event) => onProviderTagChange(event.target.value)}
                >
                  {!selectedEndpoint && <option value="">{t('image.settings.noProviders')}</option>}
                  {availableEndpoints.map((endpoint) => (
                    <option
                      key={endpoint.providerTag}
                      value={endpoint.providerTag}
                      disabled={endpoint.unavailableReason !== null}
                    >
                      {endpoint.providerName}
                    </option>
                  ))}
                </select>
              </div>
              {selectedEndpoint ? (
                <ModelCapabilities capabilities={selectedEndpoint.capabilities} />
              ) : (
                <p role="status" className={css({ textStyle: 'body', color: 'text-muted' })}>
                  {availableEndpoints[0]?.unavailableReason ?? t('image.settings.noAvailableProvider')}
                </p>
              )}
            </>
          )}
          {credentials.length > 1 && (
            <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
              <Label htmlFor="image-credential-select">{t('image.settings.useCredential')}</Label>
              <select
                id="image-credential-select"
                className={selectClass}
                value={selectedCredential}
                onChange={(event) => onCredentialChange(event.target.value)}
              >
                {credentials
                  .filter((entry) => entry.name !== '')
                  .map((entry) => (
                    <option key={entry.key}>{entry.name}</option>
                  ))}
              </select>
            </div>
          )}
        </div>
      )}
      <Button variant="outline" color="secondary" disabled={!canAdd} onClick={onAddModel}>
        {alreadyAdded ? t('image.settings.alreadyAdded') : t('image.settings.addModel')}
      </Button>
    </>
  );
}
