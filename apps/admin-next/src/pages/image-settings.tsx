import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CredentialsFields } from '@/components/image-settings/credentials-fields.tsx';
import { ModelList } from '@/components/image-settings/model-list.tsx';
import { ModelPicker } from '@/components/image-settings/model-picker.tsx';
import { SaveActions } from '@/components/image-settings/save-actions.tsx';
import { type EditableCredential, type EditableModel, toModelPayload } from '@/components/image-settings/shared.ts';
import { Panel } from '@/components/layout/panel';
import { Button } from '@/components/ui/button';

import { errorMessage } from '@/lib/errors';
import {
  getImageConfig,
  getImageModelCatalog,
  getImageModelEndpoints,
  getImageStatus,
  putImageConfig,
} from '@/lib/api/images.ts';
import type { ImageConfigView } from '@/lib/api/images.ts';

export default function ImageSettingsPage() {
  const { t } = useTranslation();
  const config = useQuery({ queryKey: ['image-config'], queryFn: getImageConfig });
  const status = useQuery({ queryKey: ['image-status'], queryFn: getImageStatus });
  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">{t('image.settings.title')}</h1>
        <p className="text-muted-foreground text-sm">
          {t('image.settings.statusLine', {
            status: status.isPending
              ? t('common.loading')
              : status.isError
                ? t('image.settings.statusReadFailed')
                : status.data.enabled
                  ? t('common.enabled')
                  : t('common.disabled'),
          })}
        </p>
      </div>
      {config.isPending ? (
        <p className="text-muted-foreground text-sm">{t('image.settings.readingConfig')}</p>
      ) : config.isError ? (
        <div role="alert" className="space-y-3">
          <p className="text-destructive text-sm">{errorMessage(config.error)}</p>
          <Button variant="outline" onClick={() => void config.refetch()}>
            {t('common.reload')}
          </Button>
        </div>
      ) : (
        <ImageSettingsForm key={config.data.revision} initial={config.data} />
      )}
    </div>
  );
}

function ImageSettingsForm({ initial }: { initial: ImageConfigView }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(initial.enabled);
  const credentialNames = [...new Set([...initial.credentials, ...initial.models.map((model) => model.credentialRef)])];
  const [credentials, setCredentials] = useState<EditableCredential[]>(() =>
    (credentialNames.length > 0 ? credentialNames : ['openrouter']).map((name) => ({
      key: crypto.randomUUID(),
      name,
      secret: '',
      saved: initial.credentials.includes(name),
      source: initial.credentials.includes(name)
        ? ''
        : initial.credential_providers.includes(name)
          ? name
          : initial.credential_providers.length === 1
            ? (initial.credential_providers[0] ?? '')
            : '',
    })),
  );
  const [models, setModels] = useState<EditableModel[]>(() =>
    [...new Map(initial.models.map((model) => [JSON.stringify(model), model])).values()].map((model) => ({
      ...model,
      key: crypto.randomUUID(),
      description: model.description ?? '',
    })),
  );
  const mergedDuplicates = initial.models.length - new Set(initial.models.map((model) => JSON.stringify(model))).size;
  const [search, setSearch] = useState('');
  const [modelId, setModelId] = useState('');
  const [providerTag, setProviderTag] = useState('');
  const [credentialRef, setCredentialRef] = useState('');
  const catalog = useQuery({
    queryKey: ['image-model-catalog'],
    queryFn: getImageModelCatalog,
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const endpoints = useQuery({
    queryKey: ['image-model-endpoints', modelId],
    queryFn: () => getImageModelEndpoints(modelId),
    enabled: enabled && modelId !== '',
    staleTime: 5 * 60_000,
    retry: false,
  });
  const catalogErrorText = catalog.isError ? errorMessage(catalog.error) : null;
  const endpointsErrorText = endpoints.isError ? errorMessage(endpoints.error) : null;
  const selectedModel = catalog.data?.models.find((model) => model.id === modelId);
  const availableEndpoints = endpoints.data?.endpoints ?? [];
  const selectedEndpoint =
    availableEndpoints.find((endpoint) => endpoint.providerTag === providerTag) ??
    availableEndpoints.find((endpoint) => endpoint.unavailableReason === null);
  const selectedCredential = credentialRef || credentials[0]?.name || '';
  const visibleModels =
    catalog.data?.models.filter(
      (model) =>
        model.id === modelId || `${model.name} ${model.id}`.toLowerCase().includes(search.trim().toLowerCase()),
    ) ?? [];
  const alreadyAdded = models.some(
    (model) => model.upstreamModel === modelId && model.providerTag === selectedEndpoint?.providerTag,
  );
  const canAddModel =
    selectedModel !== undefined &&
    selectedEndpoint !== undefined &&
    selectedEndpoint.unavailableReason === null &&
    selectedCredential !== '' &&
    !alreadyAdded &&
    models.length < 64;
  const editedCredentials = credentials.filter(
    (entry) => entry.saved || entry.name.trim() || entry.secret.trim() || entry.source,
  );
  const invalidName = editedCredentials.find((entry) => !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.name));
  const missingKey = editedCredentials.find((entry) => !entry.saved && !entry.secret.trim() && !entry.source);
  const missingReference = models.find(
    (model) => !editedCredentials.some((entry) => entry.name === model.credentialRef),
  );
  const validationError = !enabled
    ? null
    : models.length === 0
      ? t('image.settings.noModelsSelected')
      : new Set(models.map((model) => model.id)).size !== models.length
        ? t('image.settings.duplicateModelIds')
        : invalidName
          ? t('image.settings.invalidCredentialName')
          : new Set(editedCredentials.map((entry) => entry.name)).size !== editedCredentials.length
            ? t('image.settings.duplicateCredentialNames')
            : missingReference
              ? t('image.settings.modelCredentialMissing', {
                  model: missingReference.name,
                  credential: missingReference.credentialRef,
                })
              : missingKey
                ? t('image.settings.credentialKeyMissing', { name: missingKey.name })
                : null;

  const save = useMutation({
    mutationFn: () => {
      if (validationError !== null) {
        throw new Error(validationError);
      }
      return putImageConfig(
        {
          enabled,
          ...(enabled
            ? {
                credentials: Object.fromEntries(
                  editedCredentials
                    .filter((entry) => entry.secret.trim() !== '')
                    .map((entry) => [entry.name, entry.secret.trim()]),
                ),
                credential_sources: Object.fromEntries(
                  editedCredentials
                    .filter((entry) => entry.source !== '' && entry.secret.trim() === '')
                    .map((entry) => [entry.name, entry.source]),
                ),
                models: models.map(toModelPayload),
              }
            : {}),
        },
        initial.revision,
      );
    },
    onSuccess: async (result) => {
      toast.success(result.enabled ? t('image.settings.appliedToast') : t('image.settings.disabledToast'));
      setCredentials((current) => current.map((entry) => ({ ...entry, secret: '' })));
      await Promise.all(
        ['image-config', 'image-status', 'providers', 'config-status'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  function addModel() {
    if (!selectedModel || !selectedEndpoint || selectedEndpoint.unavailableReason !== null || alreadyAdded) {
      return;
    }
    setModels((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        id: selectedEndpoint.id,
        name: selectedModel.name,
        provider: 'openrouter',
        upstreamModel: selectedModel.id,
        credentialRef: selectedCredential,
        providerTag: selectedEndpoint.providerTag,
        capabilities: selectedEndpoint.capabilities,
        description: '',
      },
    ]);
    setModelId('');
    setProviderTag('');
    setSearch('');
  }

  return (
    <div className="space-y-6">
      <Panel title={t('image.settings.enablePanelTitle')}>
        <fieldset disabled={save.isPending} className="min-w-0 space-y-5">
          <CredentialsFields
            enabled={enabled}
            onEnabledChange={setEnabled}
            credentials={credentials}
            setCredentials={setCredentials}
            models={models}
            savedNames={initial.credentials}
            credentialProviders={initial.credential_providers}
          />
        </fieldset>
      </Panel>
      {enabled && (
        <Panel
          title={t('image.settings.modelsPanelTitle')}
          action={
            <Button
              size="sm"
              variant="outline"
              disabled={catalog.isFetching || save.isPending}
              onClick={() => {
                void catalog.refetch();
                if (modelId) {
                  void endpoints.refetch();
                }
              }}
            >
              {catalog.isFetching ? t('image.settings.fetchingModels') : t('image.settings.refreshModels')}
            </Button>
          }
        >
          <fieldset disabled={save.isPending} className="min-w-0 space-y-5">
            <ModelPicker
              catalogPending={catalog.isPending}
              catalogErrorText={catalogErrorText}
              search={search}
              onSearchChange={setSearch}
              modelId={modelId}
              onModelChange={(value) => {
                setModelId(value);
                setProviderTag('');
              }}
              visibleModels={visibleModels}
              endpointsPending={endpoints.isPending}
              endpointsErrorText={endpointsErrorText}
              onRetryEndpoints={() => void endpoints.refetch()}
              availableEndpoints={availableEndpoints}
              selectedEndpoint={selectedEndpoint}
              onProviderTagChange={setProviderTag}
              credentials={credentials}
              selectedCredential={selectedCredential}
              onCredentialChange={setCredentialRef}
              alreadyAdded={alreadyAdded}
              canAdd={canAddModel}
              onAddModel={addModel}
            />
            <ModelList models={models} setModels={setModels} mergedDuplicates={mergedDuplicates} />
          </fieldset>
        </Panel>
      )}
      <SaveActions
        validationError={validationError}
        saveErrorText={save.isError && validationError === null ? errorMessage(save.error) : null}
        savePending={save.isPending}
        onSave={() => save.mutate()}
      />
    </div>
  );
}
