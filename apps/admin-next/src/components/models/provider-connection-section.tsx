import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Panel } from '@/components/layout/panel';
import { HeaderFields } from '@/components/models/header-fields';
import { SecretField } from '@/components/secret-input/secret-field.tsx';
import type { ProviderApi, ProviderView, UpdateProviderRequest } from '@/lib/api/providers.ts';
import { PROVIDER_APIS, updateProvider } from '@/lib/api/providers.ts';
import { type HeaderRow, headerPayload, headerRowsFromNames, removedHeaderNames } from '@/lib/header-rows.ts';
import { providerApiLabel, requestErrorMessage } from '@/lib/model-manager.ts';
import { keychainQuery } from '@/lib/queries';
import { initialSecretDraft, type SecretDraft, secretNameInvalid, secretValueOf } from '@/lib/secret-draft.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';

/**
 * Connection fields of one provider. Builtin providers keep Pi's address and
 * adapter (read-only); only their key can change. Secrets are write-only: the
 * panel shows an empty password field, never a value and never a reveal button.
 */
export function ProviderConnectionSection({
  provider,
  revision,
}: {
  readonly provider: ProviderView;
  readonly revision: string;
}): ReactElement {
  const { t } = useTranslation();
  const write = useProviderWrite();
  // The provider and revision the drafts below were built from. Every comparison
  // and the If-Match of a save use this baseline, never the latest query data:
  // comparing stale header rows against freshly fetched names read a header
  // someone else just added as a deletion, and the fresh revision let that save
  // through.
  const [baseline, setBaseline] = useState({ provider, revision });
  const [baseUrl, setBaseUrl] = useState(provider.base_url);
  const [api, setApi] = useState<ProviderApi>(provider.api);
  const [keyDraft, setKeyDraft] = useState<SecretDraft>(() =>
    initialSecretDraft(provider.api_key_source ?? null, provider.alias),
  );
  const [headers, setHeaders] = useState<readonly HeaderRow[]>(() =>
    headerRowsFromNames(provider.header_names, provider.header_sources ?? {}),
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const [keyChecked, setKeyChecked] = useState(false);

  const base = baseline.provider;
  const custom = base.kind === 'custom';
  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  const baseUrlChanged = custom && trimmedBaseUrl !== base.base_url;
  const apiChanged = custom && api !== base.api;
  const removed = removedHeaderNames(base.header_names, headers);
  const payload = headerPayload(headers, removed, base.alias);
  const submittedKey = secretValueOf(keyDraft, base.alias);
  const dirty = baseUrlChanged || apiChanged || submittedKey !== null || payload.headers !== undefined;
  const stale = revision !== baseline.revision;
  const apiKeyMissing = keyChecked && baseUrlChanged && submittedKey === null;
  const keychain = useQuery(keychainQuery);
  const entries = (keychain.data?.entries ?? []).map((entry) => entry.name);

  const resetDrafts = (next: ProviderView, nextRevision: string): void => {
    setBaseline({ provider: next, revision: nextRevision });
    setBaseUrl(next.base_url);
    setApi(next.api);
    setKeyDraft(initialSecretDraft(next.api_key_source ?? null, next.alias));
    setHeaders(headerRowsFromNames(next.header_names, next.header_sources ?? {}));
    setLocalError(null);
    setKeyChecked(false);
  };

  // Untouched drafts simply follow the server. Edited ones wait for an explicit
  // reload, so a refresh never silently merges into what the admin typed.
  useEffect(() => {
    if (stale && !dirty) {
      setBaseline({ provider, revision });
      setBaseUrl(provider.base_url);
      setApi(provider.api);
      setKeyDraft(initialSecretDraft(provider.api_key_source ?? null, provider.alias));
      setHeaders(headerRowsFromNames(provider.header_names, provider.header_sources ?? {}));
    }
  }, [stale, dirty, provider, revision]);

  const save = useMutation({
    mutationFn: (body: UpdateProviderRequest) => updateProvider(base.alias, body, baseline.revision),
    onSuccess: (result) => {
      const saved = result.providers.find((candidate) => candidate.alias === base.alias);
      setKeyDraft({ mode: 'new', value: '', name: base.alias });
      setLocalError(null);
      if (saved !== undefined) {
        resetDrafts(saved, result.revision);
      }
      write.succeeded(result.apply);
      // The request body carries the plaintext key; resetting the mutation drops
      // it from the mutation cache as soon as the request is over.
      save.reset();
    },
    onError: (error) => {
      write.failed(error);
      // The message is kept in local state so the mutation (and with it the key
      // in `variables`) can be dropped right away.
      setLocalError(requestErrorMessage(error));
      save.reset();
    },
  });

  const submit = (): void => {
    if (payload.error !== null) {
      setLocalError(payload.error);
      return;
    }
    if (payload.error !== null) {
      setLocalError(payload.error);
      return;
    }
    if (secretNameInvalid(keyDraft)) {
      setLocalError(t('common.secret.nameInvalid'));
      return;
    }
    const body: UpdateProviderRequest = {
      ...(baseUrlChanged ? { base_url: trimmedBaseUrl } : {}),
      ...(apiChanged ? { api } : {}),
      ...(submittedKey === null ? {} : { api_key: submittedKey }),
      ...(payload.headers === undefined ? {} : { headers: payload.headers }),
    };
    setLocalError(null);
    save.mutate(body);
  };

  const error = localError;

  return (
    <Panel
      variant="plain"
      title={t('models.models.connection.title')}
      action={
        <Button disabled={!dirty || stale} loading={save.isPending} loadingLabel={t('common.saving')} onClick={submit}>
          {t('common.save')}
        </Button>
      }
    >
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
        {custom && api === 'openai-responses' ? (
          <Alert tone="warning">{t('models.models.connection.responsesWarning')}</Alert>
        ) : null}
        {baseUrlChanged ? <Alert tone="warning">{t('models.models.connection.changedWarning')}</Alert> : null}
        {stale && dirty ? (
          <Alert
            tone="warning"
            action={
              <Button size="sm" variant="ghost" color="secondary" onClick={() => resetDrafts(provider, revision)}>
                {t('common.reload')}
              </Button>
            }
          >
            {t('models.models.connection.staleWarning')}
          </Alert>
        ) : null}
        {error !== null ? <Alert tone="error">{error}</Alert> : null}
        <div
          className={css({
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr)',
            gap: '4',
            '@media (min-width: 640px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
          })}
        >
          <Field
            label={t('models.models.connection.baseUrl')}
            help={custom ? t('models.models.connection.baseUrlHint') : t('models.models.connection.builtinHint')}
          >
            <Input
              value={baseUrl}
              disabled={!custom}
              onChange={(event) => {
                setBaseUrl(event.target.value);
                setLocalError(null);
              }}
              dir="ltr"
            />
          </Field>
          <Field label={t('models.models.connection.api')}>
            <Select
              value={api}
              disabled={!custom}
              onChange={(event) => setApi(event.target.value as ProviderApi)}
              options={PROVIDER_APIS.map((value) => ({ value, label: providerApiLabel(value) }))}
            />
          </Field>
          <div className={css({ '@media (min-width: 640px)': { gridColumn: 'span 2' } })}>
            <SecretField
              label={t('models.models.connection.apiKey')}
              draft={keyDraft}
              source={provider.api_key_source ?? null}
              entries={entries}
              suggestedName={base.alias}
              disabled={false}
              onChange={(draft) => {
                setKeyDraft(draft);
                setLocalError(null);
              }}
              idPrefix={`provider-key-${base.alias}`}
            />
            {apiKeyMissing ? (
              <p role="alert" className={css({ textStyle: 'small', color: 'error-text' })}>
                {t('models.models.connection.needsApiKey')}
              </p>
            ) : null}
          </div>
        </div>

        {custom ? (
          <div className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
            <h3 className={css({ margin: '0', textStyle: 'label' })}>{t('models.models.connection.headersTitle')}</h3>
            <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>
              {t('models.models.connection.headersHint')}
            </p>
            <HeaderFields
              rows={headers}
              onChange={(rows) => {
                setHeaders(rows);
                setLocalError(null);
              }}
              valuesRequired={baseUrlChanged}
              nameBase={base.alias}
              keychainEntries={entries}
              keySources={provider.header_sources ?? {}}
            />
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
