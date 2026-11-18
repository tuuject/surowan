import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormActionBar, ListPageHeader } from '@/components/business';
import { RefreshIcon } from '@/components/icons';
import { CredentialsFields } from '@/components/image-settings/credentials-fields.tsx';
import { ModelList } from '@/components/image-settings/model-list.tsx';
import { ModelPicker } from '@/components/image-settings/model-picker.tsx';
import { type EditableCredential, type EditableModel, toModelPayload } from '@/components/image-settings/shared.ts';
import { Panel } from '@/components/layout/panel';
import type { ImageConfigView } from '@/lib/api/images.ts';
import {
  getImageConfig,
  getImageModelCatalog,
  getImageModelEndpoints,
  getImageStatus,
  putImageConfig,
} from '@/lib/api/images.ts';
import { errorMessage } from '@/lib/errors';
import { keychainQuery } from '@/lib/queries';
import { initialSecretDraft, secretValueOf } from '@/lib/secret-draft.ts';
import { toast } from '@/lib/toast.ts';

export default function ImageSettingsPage() {
  const { t } = useTranslation();
  const config = useQuery({ queryKey: ['image-config'], queryFn: getImageConfig });
  const status = useQuery({ queryKey: ['image-status'], queryFn: getImageStatus });
  return (
    // The settings column: one width-limited form, as on Settings and Harness.
    <div className={css({ maxWidth: '768px', marginInline: 'auto', '& > * + *': { marginBlockStart: '6' } })}>
      <ListPageHeader
        title={t('image.settings.title')}
        description={t('image.settings.statusLine', {
          status: status.isPending
            ? t('common.loading')
            : status.isError
              ? t('image.settings.statusReadFailed')
              : status.data.enabled
                ? t('common.enabled')
                : t('common.disabled'),
        })}
      />
      {config.isPending ? (
        <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('image.settings.readingConfig')}</p>
      ) : config.isError ? (
        <Alert
          tone="error"
          action={
            <Button size="sm" variant="ghost" color="secondary" onClick={() => void config.refetch()}>
              {t('common.reload')}
            </Button>
          }
        >
          {errorMessage(config.error)}
        </Alert>
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
      saved: initial.credentials.includes(name),
      draft: initialSecretDraft(initial.credential_key_sources?.[name] ?? null, name),
    })),
  );
  const keychain = useQuery(keychainQuery);
  const keychainEntries = (keychain.data?.entries ?? []).map((entry) => entry.name);
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
    (entry) => entry.saved || entry.name.trim() || entry.draft.mode !== 'external',
  );
  const invalidName = editedCredentials.find((entry) => !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.name));
  const missingKey = editedCredentials.find(
    (entry) =>
      !entry.saved &&
      (entry.draft.mode === 'external' ||
        (entry.draft.mode === 'new' && !entry.draft.value.trim()) ||
        (entry.draft.mode === 'entry' && !entry.draft.entry)),
  );
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
                // A submitted key (new plaintext or a picked entry) travels as
                // the shared SecretInput; a row left on its stored reference
                // is omitted, so the server keeps it.
                credentials: Object.fromEntries(
                  editedCredentials.flatMap((entry) => {
                    const value = secretValueOf(entry.draft, entry.name.trim() || entry.name);
                    return value === null ? [] : [[entry.name.trim() || entry.name, value] as const];
                  }),
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
      setCredentials((current) =>
        current.map((entry) => ({
          ...entry,
          draft: { ...entry.draft, ...(entry.draft.mode === 'new' ? { value: '' } : {}) },
        })),
      );
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
    <div className={css({ '& > * + *': { marginBlockStart: '6' } })}>
      <Panel title={t('image.settings.enablePanelTitle')}>
        <fieldset
          disabled={save.isPending}
          className={css({ minWidth: '0', display: 'flex', flexDirection: 'column', gap: '5' })}
        >
          <CredentialsFields
            enabled={enabled}
            onEnabledChange={setEnabled}
            credentials={credentials}
            setCredentials={setCredentials}
            models={models}
            keychainEntries={keychainEntries}
            keySources={initial.credential_key_sources ?? {}}
          />
        </fieldset>
      </Panel>
      {enabled && (
        <Panel
          title={t('image.settings.modelsPanelTitle')}
          action={
            <Button
              variant="outline"
              color="secondary"
              iconStart={<RefreshIcon />}
              disabled={save.isPending}
              loading={catalog.isFetching}
              loadingLabel={t('image.settings.fetchingModels')}
              onClick={() => {
                void catalog.refetch();
                if (modelId) {
                  void endpoints.refetch();
                }
              }}
            >
              {t('image.settings.refreshModels')}
            </Button>
          }
        >
          <fieldset
            disabled={save.isPending}
            className={css({ minWidth: '0', display: 'flex', flexDirection: 'column', gap: '5' })}
          >
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
      <FormActionBar
        status={validationError ?? t('image.settings.readyToSave')}
        statusId="image-save-requirements"
        error={save.isError && validationError === null ? errorMessage(save.error) : null}
        submitType="button"
        submitLabel={t('image.settings.saveAndApply')}
        submittingLabel={t('common.saving')}
        submitting={save.isPending}
        onSubmit={() => {
          if (validationError !== null) {
            toast.error(validationError);
            return;
          }
          save.mutate();
        }}
      />
    </div>
  );
}
