import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Field } from '@tuuject/koi-react/field';
import { PlusIcon } from '@tuuject/koi-react/icons';
import { Input } from '@tuuject/koi-react/input';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import type { ImageCatalogEndpoint } from '@/lib/api/images.ts';
import { ModelCapabilities } from './model-capabilities.tsx';
import type { EditableCredential } from './shared.ts';

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
      {catalogErrorText !== null && (
        <Alert tone="error">{t('image.settings.catalogError', { error: catalogErrorText })}</Alert>
      )}
      <Field label={t('image.settings.searchModels')}>
        <Input
          placeholder={t('image.settings.searchPlaceholder')}
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </Field>
      <Field label={t('image.settings.modelSelectLabel')}>
        <Select
          value={modelId}
          disabled={catalogPending || visibleModels.length === 0}
          onChange={(event) => onModelChange(event.target.value)}
          options={[
            {
              value: '',
              label: catalogPending
                ? t('image.settings.fetchingModelsOption')
                : visibleModels.length === 0
                  ? t('image.settings.noMatchingModels')
                  : t('image.settings.selectModelOption'),
            },
            ...visibleModels.map((model) => ({ value: model.id, label: `${model.name}（${model.id}）` })),
          ]}
        />
      </Field>
      {modelId && (
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
          {endpointsPending ? (
            <p role="status" className={css({ margin: '0', color: 'text-muted' })}>
              {t('image.settings.readingEndpoints')}
            </p>
          ) : endpointsErrorText !== null ? (
            <Alert
              tone="error"
              action={
                <Button size="sm" variant="ghost" color="secondary" onClick={onRetryEndpoints}>
                  {t('image.settings.retryProviders')}
                </Button>
              }
            >
              {t('image.settings.endpointsError', { error: endpointsErrorText })}
            </Alert>
          ) : (
            <>
              <Field label={t('image.settings.provider')}>
                <Select
                  value={selectedEndpoint?.providerTag ?? ''}
                  onChange={(event) => onProviderTagChange(event.target.value)}
                  options={[
                    ...(selectedEndpoint === undefined ? [{ value: '', label: t('image.settings.noProviders') }] : []),
                    ...availableEndpoints.map((endpoint) => ({
                      value: endpoint.providerTag,
                      label: endpoint.providerName,
                      disabled: endpoint.unavailableReason !== null,
                    })),
                  ]}
                />
              </Field>
              {selectedEndpoint ? (
                <ModelCapabilities capabilities={selectedEndpoint.capabilities} />
              ) : (
                <p role="status" className={css({ margin: '0', color: 'text-muted' })}>
                  {availableEndpoints[0]?.unavailableReason ?? t('image.settings.noAvailableProvider')}
                </p>
              )}
            </>
          )}
          {credentials.length > 1 && (
            <Field label={t('image.settings.useCredential')}>
              <Select
                value={selectedCredential}
                onChange={(event) => onCredentialChange(event.target.value)}
                options={credentials
                  .filter((entry) => entry.name !== '')
                  .map((entry) => ({ value: entry.name, label: entry.name }))}
              />
            </Field>
          )}
        </div>
      )}
      <Button
        variant="outline"
        iconStart={<PlusIcon />}
        className={css({ alignSelf: 'flex-start' })}
        disabled={!canAdd}
        onClick={onAddModel}
      >
        {alreadyAdded ? t('image.settings.alreadyAdded') : t('image.settings.addModel')}
      </Button>
    </>
  );
}
