import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { field } from '@tuuject/koi-react/styled-system/recipes';
import { Textarea } from '@tuuject/koi-react/textarea';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MonoValue } from '@/components/business';
import { HeaderFields } from '@/components/models/header-fields';
import { ModelDraftList } from '@/components/models/model-draft-list';
import { ModelEditDialog } from '@/components/models/model-edit-dialog';
import { useDraftSelection } from '@/components/models/use-draft-selection';
import type {
  CreateProviderRequest,
  DiscoveredModel,
  ProviderApi,
  ProviderKind,
  ProviderModelConfig,
} from '@/lib/api/providers.ts';
import { createProvider, discoverProviderModels, lookupModelMetadata, PROVIDER_APIS } from '@/lib/api/providers.ts';
import { type HeaderRow, headerRowsFromNames, headerValues } from '@/lib/header-rows.ts';
import { modelFormFromDraft } from '@/lib/model-form.ts';
import { parseModelIds, requestErrorMessage } from '@/lib/model-manager.ts';
import { providerPresetsQuery } from '@/lib/queries.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';

/** Koi Field's label, for the few controls that share one label with a status line or a second control. */
const fieldLabel = field().label;

const ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

type WizardStep = 'connection' | 'credentials' | 'models';

/**
 * New-provider wizard: connection → credentials → models. The model
 * list is never prefilled (C8): it comes from the provider's own listing with
 * the key that was just typed, or from ids the admin enters by hand.
 */
export function ProviderWizard({
  revision,
  onClose,
  onCreated,
}: {
  readonly revision: string;
  readonly onClose: () => void;
  /** Runs after a successful create, so the page can select the new provider. */
  readonly onCreated: (alias: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const write = useProviderWrite();
  const presets = useQuery(providerPresetsQuery);
  const selection = useDraftSelection();

  const [step, setStep] = useState<WizardStep>('connection');
  const [kind, setKind] = useState<ProviderKind>('builtin');
  const [alias, setAlias] = useState('');
  const [presetId, setPresetId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [api, setApi] = useState<ProviderApi>('openai-completions');
  const [apiKey, setApiKey] = useState('');
  const [headers, setHeaders] = useState<readonly HeaderRow[]>(() => headerRowsFromNames([]));
  const [ids, setIds] = useState('');
  const [editing, setEditing] = useState<DiscoveredModel | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const stepTitles: Record<WizardStep, string> = {
    connection: t('models.models.wizard.stepConnection'),
    credentials: t('models.models.wizard.stepCredentials'),
    models: t('models.models.wizard.stepModels'),
  };

  const preset = (presets.data?.presets ?? []).find((candidate) => candidate.id === presetId) ?? null;
  const aliasValid = ALIAS_PATTERN.test(alias);

  const connection: {
    readonly kind: ProviderKind;
    readonly provider?: string;
    readonly base_url?: string;
    readonly api?: ProviderApi;
  } = kind === 'builtin' ? { kind, provider: presetId } : { kind, base_url: baseUrl.trim(), api };

  const discover = useMutation({
    mutationFn: async () => {
      const payload = headerValues(headers);
      if (payload.error !== null) {
        throw new Error(payload.error);
      }
      if (apiKey.length === 0) {
        throw new Error(t('models.models.wizard.enterApiKeyFirst'));
      }
      return await discoverProviderModels({
        ...connection,
        api_key: apiKey,
        ...(payload.values === undefined ? {} : { headers: payload.values }),
      });
    },
    onSuccess: (result) => {
      selection.replaceDrafts(result.models);
    },
  });

  const lookup = useMutation({
    mutationFn: async () => {
      const parsed = parseModelIds(ids);
      if (parsed.length === 0) {
        throw new Error(t('models.models.wizard.enterModelId'));
      }
      const result = await lookupModelMetadata({ ...connection, ids: parsed });
      return result.models.map((draft) => ({ ...draft, configured: false }));
    },
    onSuccess: (models) => {
      selection.replaceDrafts(models);
    },
  });

  const create = useMutation({
    mutationFn: (body: CreateProviderRequest) => createProvider(body, revision),
    onSuccess: (result) => {
      // A create is applied immediately like every other write, so the same
      // feedback shows and the wizard hands the new provider to the page.
      write.succeeded(result.apply);
      onCreated(alias);
      onClose();
      // The body carries the plaintext key; resetting drops it from the
      // mutation cache once the request is over.
      create.reset();
    },
    onError: (error) => {
      write.failed(error);
      setCreateError(requestErrorMessage(error));
      create.reset();
    },
  });

  const submit = (): void => {
    if (selection.models === null) {
      return;
    }
    const payload = headerValues(headers);
    if (payload.error !== null) {
      // An incomplete header row must stop the submit: dropping it silently
      // would create the provider without a header the admin meant to send.
      setCreateError(payload.error);
      return;
    }
    setCreateError(null);
    create.mutate({
      alias,
      kind,
      ...(kind === 'builtin' ? { provider: presetId } : { base_url: baseUrl.trim(), api }),
      api_key: apiKey,
      ...(payload.values === undefined ? {} : { headers: payload.values }),
      models: selection.models,
    });
  };

  const fetchError = step === 'models' ? (discover.error ?? lookup.error) : null;
  const fetchPending = discover.isPending || lookup.isPending;

  return (
    <>
      <Dialog
        open
        onOpenChange={(next) => {
          if (!next) {
            onClose();
          }
        }}
        title={t('models.models.wizard.title', { step: stepTitles[step] })}
        description={t('models.models.wizard.description')}
        size="lg"
        footer={
          <>
            <Button type="button" variant="ghost" color="secondary" disabled={create.isPending} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            {step === 'connection' ? (
              <Button
                type="button"
                disabled={!aliasValid || (kind === 'builtin' ? presetId.length === 0 : baseUrl.trim().length === 0)}
                onClick={() => setStep('credentials')}
              >
                {t('models.models.wizard.next')}
              </Button>
            ) : null}
            {step === 'credentials' ? (
              <Button type="button" disabled={apiKey.length === 0} onClick={() => setStep('models')}>
                {t('models.models.wizard.next')}
              </Button>
            ) : null}
            {step === 'models' ? (
              <Button type="button" disabled={create.isPending || selection.models === null} onClick={submit}>
                {create.isPending ? t('common.saving') : t('models.models.wizard.createProvider')}
              </Button>
            ) : null}
          </>
        }
      >
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
          {step === 'connection' ? (
            <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
              <Field id="wizard-kind" label={t('models.models.wizard.kind')}>
                <Select
                  className={css({ width: '100%', md: { width: '256px' } })}
                  value={kind}
                  onChange={(event) => setKind(event.target.value as ProviderKind)}
                >
                  <option value="builtin">{t('models.models.wizard.builtinKind')}</option>
                  <option value="custom">{t('models.models.wizard.customKind')}</option>
                </Select>
              </Field>
              <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
                <label htmlFor="wizard-alias" className={fieldLabel}>
                  {t('models.models.wizard.alias')}
                </label>
                <Input
                  id="wizard-alias"
                  value={alias}
                  placeholder="openrouter"
                  onChange={(event) => setAlias(event.target.value)}
                />
                <p className={css({ textStyle: 'small', color: 'text-muted' })}>
                  {t('models.models.wizard.aliasHint')}
                </p>
                {alias.length > 0 && !aliasValid ? (
                  <p className={css({ textStyle: 'body', color: 'error-text' })}>
                    {t('models.models.wizard.aliasInvalid')}
                  </p>
                ) : null}
              </div>
              {kind === 'builtin' ? (
                <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
                  <label htmlFor="wizard-preset" className={fieldLabel}>
                    {t('models.models.wizard.piProvider')}
                  </label>
                  {presets.isPending ? (
                    <p className={css({ textStyle: 'body', color: 'text-muted' })}>
                      {t('models.models.wizard.loadingPresets')}
                    </p>
                  ) : presets.isError ? (
                    <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
                      {requestErrorMessage(presets.error)}
                    </p>
                  ) : (
                    <Select
                      id="wizard-preset"
                      className={css({ width: '100%' })}
                      value={presetId}
                      placeholder={t('models.models.wizard.pickPreset')}
                      onChange={(event) => setPresetId(event.target.value)}
                    >
                      {(presets.data?.presets ?? []).map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.name} ({candidate.api})
                        </option>
                      ))}
                    </Select>
                  )}
                  {preset === null ? null : (
                    <p className={css({ textStyle: 'small', color: 'text-muted' })}>
                      {t('models.models.wizard.presetBaseUrl')}
                      <MonoValue value={preset.base_url} />
                    </p>
                  )}
                </div>
              ) : (
                <div
                  className={css({
                    display: 'grid',
                    gap: '4',
                    md: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
                  })}
                >
                  <Field id="wizard-base-url" label={t('models.models.connection.baseUrl')}>
                    <Input
                      value={baseUrl}
                      placeholder="https://example.com/v1"
                      onChange={(event) => setBaseUrl(event.target.value)}
                    />
                  </Field>
                  <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
                    <label htmlFor="wizard-api" className={fieldLabel}>
                      {t('models.models.connection.api')}
                    </label>
                    <Select
                      id="wizard-api"
                      className={css({ width: '100%' })}
                      value={api}
                      onChange={(event) => setApi(event.target.value as ProviderApi)}
                    >
                      {PROVIDER_APIS.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </Select>
                    {api === 'google-generative-ai' ? (
                      <p className={css({ textStyle: 'small', color: 'text-muted' })}>
                        {t('models.models.wizard.googleNote')}
                      </p>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          ) : null}

          {step === 'credentials' ? (
            <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
              <Field
                id="wizard-api-key"
                label={t('models.models.connection.apiKey')}
                help={t('models.models.wizard.apiKeyHint')}
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </Field>
              {kind === 'custom' ? (
                <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
                  <p className={css({ textStyle: 'label' })}>{t('models.models.wizard.headersOptional')}</p>
                  <HeaderFields rows={headers} onChange={setHeaders} valuesRequired={false} />
                </div>
              ) : null}
            </div>
          ) : null}

          {step === 'models' ? (
            <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
              <p className={css({ textStyle: 'small', color: 'text-muted' })}>
                {t('models.models.wizard.tempModeNote')}
              </p>
              <div className={css({ display: 'flex', flexWrap: 'wrap', gap: '2' })}>
                <Button
                  type="button"
                  variant="outline"
                  color="secondary"
                  size="sm"
                  disabled={fetchPending}
                  onClick={() => {
                    discover.mutate();
                  }}
                >
                  {fetchPending ? t('models.models.picker.fetching') : t('models.models.wizard.fetch')}
                </Button>
              </div>
              <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
                <label htmlFor="wizard-ids" className={fieldLabel}>
                  {t('models.models.wizard.idsLabel')}
                </label>
                <Textarea id="wizard-ids" rows={2} value={ids} onChange={(event) => setIds(event.target.value)} />
                <Button
                  type="button"
                  variant="outline"
                  color="secondary"
                  size="sm"
                  disabled={fetchPending}
                  onClick={() => {
                    lookup.mutate();
                  }}
                >
                  {t('models.models.wizard.lookup')}
                </Button>
              </div>
              {fetchError === null ? null : (
                <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
                  {requestErrorMessage(fetchError)}
                </p>
              )}
              {selection.drafts.length === 0 ? null : (
                <>
                  <ModelDraftList
                    drafts={selection.visibleDrafts}
                    selected={selection.selected}
                    resolved={selection.resolved}
                    onToggle={selection.toggle}
                    onEdit={setEditing}
                    search={selection.search}
                    onSearchChange={selection.setSearch}
                    emptyText={t('models.models.shared.emptyList')}
                  />
                  <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
                    <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>
                      {t('models.models.shared.selectedCount', { count: selection.selectedCount })}
                    </p>
                    {selection.unresolved.length === 0 ? null : (
                      <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>
                        {t('models.models.shared.unresolvedSuffix', {
                          ids: selection.unresolved.map((draft) => draft.id).join(', '),
                        })}
                      </p>
                    )}
                    {selection.confirmable === 0 ? null : (
                      <Button
                        type="button"
                        variant="outline"
                        color="secondary"
                        size="sm"
                        onClick={selection.confirmSelected}
                      >
                        {t('models.models.shared.acceptListed', { count: selection.confirmable })}
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : null}

          {createError === null ? null : (
            <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>{createError}</p>
          )}
        </div>
      </Dialog>
      {editing === null ? null : (
        <ModelEditDialog
          key={`confirm-${editing.id}`}
          open
          onOpenChange={(next) => {
            if (!next) {
              setEditing(null);
            }
          }}
          api={kind === 'builtin' ? (preset?.api ?? api) : api}
          title={t('models.models.wizard.confirmTitle', { model: editing.id })}
          description={t('models.models.wizard.confirmDescription')}
          initial={modelFormFromDraft(editing, kind === 'builtin' ? (preset?.api ?? api) : api)}
          lockId
          draft={editing}
          pending={false}
          error={null}
          onSubmit={(model: ProviderModelConfig) => {
            selection.resolve(editing.id, model);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}
