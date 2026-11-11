import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModelEditDialog } from '@/components/models/model-edit-dialog';
import {
  WizardConnectionStep,
  WizardCredentialsStep,
  WizardModelsStep,
} from '@/components/models/provider-wizard-steps';
import { useDraftSelection } from '@/components/models/use-draft-selection';
import { useOpenSession } from '@/hooks/use-open-session.ts';
import type {
  CreateProviderRequest,
  DiscoveredModel,
  ProviderApi,
  ProviderKind,
  ProviderModelConfig,
} from '@/lib/api/providers.ts';
import { createProvider, discoverProviderModels, lookupModelMetadata } from '@/lib/api/providers.ts';
import { type HeaderRow, headerRowsFromNames, headerValues } from '@/lib/header-rows.ts';
import { modelFormForDraft } from '@/lib/model-form.ts';
import { parseModelIds, requestErrorMessage } from '@/lib/model-manager.ts';
import { providerPresetsQuery } from '@/lib/queries.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';

const ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

type WizardStep = 'connection' | 'credentials' | 'models';

/**
 * New-provider wizard: connection → credentials → models. The model
 * list is never prefilled (C8): it comes from the provider's own listing with
 * the key that was just typed, or from ids the admin enters by hand.
 *
 * The page keeps this mounted and drives it with `open`, so Base UI can play
 * both transitions; `formKey` starts a fresh wizard — step one and empty
 * fields — on every open.
 */
export function ProviderWizard({
  open,
  onOpenChange,
  formKey,
  revision,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Incremented by the page for every open: a new wizard, not a new dialog. */
  readonly formKey: number;
  readonly revision: string;
  /** Runs after a successful create, so the page can select the new provider. */
  readonly onCreated: (alias: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const write = useProviderWrite();
  const presets = useQuery({ ...providerPresetsQuery, enabled: open });
  const selection = useDraftSelection();
  // Discovery and lookup can be abandoned by closing the wizard, and they still
  // answer. Each request carries the session it started in, so a late answer
  // cannot put one wizard's models or error into the next.
  const session = useOpenSession(open);

  const [sessionKey, setSessionKey] = useState(formKey);
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
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmNonce, setConfirmNonce] = useState(0);
  // The api the open confirm was started for: a background preset refetch must
  // not change the fields the admin is looking at.
  const [confirmApi, setConfirmApi] = useState<ProviderApi>('openai-completions');
  const [createError, setCreateError] = useState<string | null>(null);
  // Kept apart from the mutation objects so a previous wizard's failure cannot
  // surface in this one.
  const [fetchError, setFetchError] = useState<unknown>(null);
  const stepTitles: Record<WizardStep, string> = {
    connection: t('models.models.wizard.stepConnection'),
    credentials: t('models.models.wizard.stepCredentials'),
    models: t('models.models.wizard.stepModels'),
  };

  const presetList = presets.data?.presets ?? [];
  const preset = presetList.find((candidate) => candidate.id === presetId) ?? null;
  const aliasValid = ALIAS_PATTERN.test(alias);

  const connection: {
    readonly kind: ProviderKind;
    readonly provider?: string;
    readonly base_url?: string;
    readonly api?: ProviderApi;
  } = kind === 'builtin' ? { kind, provider: presetId } : { kind, base_url: baseUrl.trim(), api };

  /** Opens the per-model confirm for the api the wizard has right now. */
  const openConfirm = (draft: DiscoveredModel): void => {
    setEditing(draft);
    setConfirmApi(kind === 'builtin' ? (preset?.api ?? api) : api);
    setConfirmNonce((previous) => previous + 1);
    setConfirmOpen(true);
  };

  const discover = useMutation({
    mutationFn: async (_startedIn: number) => {
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
    onSuccess: (result, startedIn) => {
      if (startedIn !== session.current) {
        return;
      }
      setFetchError(null);
      selection.replaceDrafts(result.models);
    },
    onError: (error, startedIn) => {
      if (startedIn === session.current) {
        setFetchError(error);
      }
    },
  });

  const lookup = useMutation({
    mutationFn: async (_startedIn: number) => {
      const parsed = parseModelIds(ids);
      if (parsed.length === 0) {
        throw new Error(t('models.models.wizard.enterModelId'));
      }
      const result = await lookupModelMetadata({ ...connection, ids: parsed });
      return result.models.map((draft) => ({ ...draft, configured: false }));
    },
    onSuccess: (models, startedIn) => {
      if (startedIn !== session.current) {
        return;
      }
      setFetchError(null);
      selection.replaceDrafts(models);
    },
    onError: (error, startedIn) => {
      if (startedIn === session.current) {
        setFetchError(error);
      }
    },
  });

  const create = useMutation({
    mutationFn: (body: CreateProviderRequest) => createProvider(body, revision),
    onSuccess: (result) => {
      // A create is applied immediately like every other write, so the same
      // feedback shows and the wizard hands the new provider to the page.
      write.succeeded(result.apply);
      onCreated(alias);
      onOpenChange(false);
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

  const fetchPending = discover.isPending || lookup.isPending;

  // Every open starts a fresh wizard: step one, empty fields, no drafts and no
  // errors from the previous one. Resetting here instead of on close is what
  // keeps the step on screen while the exit transition plays.
  if (sessionKey !== formKey) {
    setSessionKey(formKey);
    setStep('connection');
    setKind('builtin');
    setAlias('');
    setPresetId('');
    setBaseUrl('');
    setApi('openai-completions');
    setApiKey('');
    setHeaders(headerRowsFromNames([]));
    setIds('');
    setEditing(null);
    setConfirmOpen(false);
    setCreateError(null);
    setFetchError(null);
    selection.reset();
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          // A create in flight closes the wizard when it lands; it must land in
          // the wizard that started it.
          if (!next && !create.isPending) {
            onOpenChange(false);
          }
        }}
        title={t('models.models.wizard.title', { step: stepTitles[step] })}
        description={t('models.models.wizard.description')}
        size="lg"
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              color="secondary"
              disabled={create.isPending}
              onClick={() => onOpenChange(false)}
            >
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
            <WizardConnectionStep
              kind={kind}
              onKindChange={setKind}
              alias={alias}
              onAliasChange={setAlias}
              aliasValid={aliasValid}
              presets={presetList}
              presetsPending={presets.isPending}
              presetsError={presets.isError ? presets.error : null}
              presetId={presetId}
              onPresetIdChange={setPresetId}
              preset={preset}
              baseUrl={baseUrl}
              onBaseUrlChange={setBaseUrl}
              api={api}
              onApiChange={setApi}
            />
          ) : null}

          {step === 'credentials' ? (
            <WizardCredentialsStep
              apiKey={apiKey}
              onApiKeyChange={setApiKey}
              headers={headers}
              onHeadersChange={setHeaders}
              custom={kind === 'custom'}
            />
          ) : null}

          {step === 'models' ? (
            <WizardModelsStep
              ids={ids}
              onIdsChange={setIds}
              fetchPending={fetchPending}
              fetchError={fetchError}
              onFetch={() => {
                setFetchError(null);
                discover.mutate(session.current);
              }}
              onLookup={() => {
                setFetchError(null);
                lookup.mutate(session.current);
              }}
              selection={selection}
              onEdit={openConfirm}
            />
          ) : null}

          {createError === null ? null : (
            <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>{createError}</p>
          )}
        </div>
      </Dialog>
      <ModelEditDialog
        open={confirmOpen}
        onOpenChange={(next) => {
          if (!next) {
            setConfirmOpen(false);
          }
        }}
        api={confirmApi}
        title={editing === null ? '' : t('models.models.wizard.confirmTitle', { model: editing.id })}
        description={t('models.models.wizard.confirmDescription')}
        initial={modelFormForDraft(editing, editing === null ? undefined : selection.resolved[editing.id], confirmApi)}
        formKey={confirmNonce}
        lockId
        draft={editing}
        pending={false}
        error={null}
        onSubmit={(model: ProviderModelConfig) => {
          if (editing !== null) {
            selection.resolve(editing.id, model);
          }
          setConfirmOpen(false);
        }}
      />
    </>
  );
}
