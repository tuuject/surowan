import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { field } from '@tuuject/koi-react/styled-system/recipes';
import { Textarea } from '@tuuject/koi-react/textarea';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { MonoValue } from '@/components/business';
import { HeaderFields } from '@/components/models/header-fields';
import { ModelDraftList } from '@/components/models/model-draft-list';
import type { DraftSelection } from '@/components/models/use-draft-selection';
import type { DiscoveredModel, ProviderApi, ProviderKind, ProviderPresetView } from '@/lib/api/providers.ts';
import { PROVIDER_APIS } from '@/lib/api/providers.ts';
import type { HeaderRow } from '@/lib/header-rows.ts';
import { providerApiLabel, requestErrorMessage } from '@/lib/model-manager.ts';

/** Koi Field's label, for the few controls that share one label with a status line or a second control. */
const fieldLabel = field().label;

/** Step one: what kind of provider this is, its alias and how to reach it. */
export function WizardConnectionStep({
  kind,
  onKindChange,
  alias,
  onAliasChange,
  aliasValid,
  presets,
  presetsPending,
  presetsError,
  presetId,
  onPresetIdChange,
  preset,
  baseUrl,
  onBaseUrlChange,
  api,
  onApiChange,
}: {
  readonly kind: ProviderKind;
  readonly onKindChange: (kind: ProviderKind) => void;
  readonly alias: string;
  readonly onAliasChange: (alias: string) => void;
  readonly aliasValid: boolean;
  readonly presets: readonly ProviderPresetView[];
  readonly presetsPending: boolean;
  readonly presetsError: unknown;
  readonly presetId: string;
  readonly onPresetIdChange: (id: string) => void;
  readonly preset: ProviderPresetView | null;
  readonly baseUrl: string;
  readonly onBaseUrlChange: (value: string) => void;
  readonly api: ProviderApi;
  readonly onApiChange: (api: ProviderApi) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
      <Field id="wizard-kind" label={t('models.models.wizard.kind')}>
        <Select
          className={css({ width: '100%' })}
          value={kind}
          onChange={(event) => onKindChange(event.target.value as ProviderKind)}
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
          onChange={(event) => onAliasChange(event.target.value)}
        />
        <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('models.models.wizard.aliasHint')}</p>
        {alias.length > 0 && !aliasValid ? (
          <p className={css({ textStyle: 'body', color: 'error-text' })}>{t('models.models.wizard.aliasInvalid')}</p>
        ) : null}
      </div>
      {kind === 'builtin' ? (
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
          <label htmlFor="wizard-preset" className={fieldLabel}>
            {t('models.models.wizard.piProvider')}
          </label>
          {presetsPending ? (
            <p className={css({ textStyle: 'body', color: 'text-muted' })}>
              {t('models.models.wizard.loadingPresets')}
            </p>
          ) : presetsError === null || presetsError === undefined ? (
            <Select
              id="wizard-preset"
              className={css({ width: '100%' })}
              value={presetId}
              placeholder={t('models.models.wizard.pickPreset')}
              onChange={(event) => onPresetIdChange(event.target.value)}
            >
              {presets.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </Select>
          ) : (
            <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
              {requestErrorMessage(presetsError)}
            </p>
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
          <Field
            id="wizard-base-url"
            label={t('models.models.connection.baseUrl')}
            help={t('models.models.connection.baseUrlHint')}
          >
            <Input
              value={baseUrl}
              placeholder="https://example.com/v1"
              onChange={(event) => onBaseUrlChange(event.target.value)}
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
              onChange={(event) => onApiChange(event.target.value as ProviderApi)}
            >
              {PROVIDER_APIS.map((value) => (
                <option key={value} value={value}>
                  {providerApiLabel(value)}
                </option>
              ))}
            </Select>
            {api === 'openai-responses' ? null : (
              <p className={css({ textStyle: 'small', color: 'text-muted' })}>
                {t('models.models.connection.apiHint')}
              </p>
            )}
            {api === 'google-generative-ai' ? (
              <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('models.models.wizard.googleNote')}</p>
            ) : null}
          </div>
          {api === 'openai-responses' ? (
            <Alert tone="warning" className={css({ gridColumn: '1 / -1' })}>
              {t('models.models.connection.responsesWarning')}
            </Alert>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Step two: the credential the listing and the provider will use, plus optional headers. */
export function WizardCredentialsStep({
  apiKey,
  onApiKeyChange,
  headers,
  onHeadersChange,
  custom,
}: {
  readonly apiKey: string;
  readonly onApiKeyChange: (value: string) => void;
  readonly headers: readonly HeaderRow[];
  readonly onHeadersChange: (rows: readonly HeaderRow[]) => void;
  /** Only a custom connection sends headers of its own. */
  readonly custom: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
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
          onChange={(event) => onApiKeyChange(event.target.value)}
        />
      </Field>
      {custom ? (
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
          <p className={css({ textStyle: 'label' })}>{t('models.models.wizard.headersOptional')}</p>
          <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>
            {t('models.models.connection.headersHint')}
          </p>
          <HeaderFields rows={headers} onChange={onHeadersChange} valuesRequired={false} />
        </div>
      ) : null}
    </div>
  );
}

/** Step three: build the model list from the provider's own listing or from typed ids. */
export function WizardModelsStep({
  ids,
  onIdsChange,
  fetchPending,
  fetchError,
  onFetch,
  onLookup,
  selection,
  onEdit,
}: {
  readonly ids: string;
  readonly onIdsChange: (value: string) => void;
  readonly fetchPending: boolean;
  readonly fetchError: unknown;
  readonly onFetch: () => void;
  readonly onLookup: () => void;
  readonly selection: DraftSelection;
  readonly onEdit: (draft: DiscoveredModel) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
      <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('models.models.wizard.tempModeNote')}</p>
      <div className={css({ display: 'flex', flexWrap: 'wrap', gap: '2' })}>
        <Button type="button" variant="outline" color="secondary" size="sm" disabled={fetchPending} onClick={onFetch}>
          {fetchPending ? t('models.models.picker.fetching') : t('models.models.wizard.fetch')}
        </Button>
      </div>
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
        <label htmlFor="wizard-ids" className={fieldLabel}>
          {t('models.models.wizard.idsLabel')}
        </label>
        <Textarea id="wizard-ids" rows={2} value={ids} onChange={(event) => onIdsChange(event.target.value)} />
        <Button type="button" variant="outline" color="secondary" size="sm" disabled={fetchPending} onClick={onLookup}>
          {t('models.models.wizard.lookup')}
        </Button>
      </div>
      {fetchError === null || fetchError === undefined ? null : (
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
            onEdit={onEdit}
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
              <Button type="button" variant="outline" color="secondary" size="sm" onClick={selection.confirmSelected}>
                {t('models.models.shared.acceptListed', { count: selection.confirmable })}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
