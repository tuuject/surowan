import { useMutation } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KvList, MonoValue } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { HeaderFields } from '@/components/models/header-fields';
import type { ProviderApi, ProviderView, UpdateProviderRequest } from '@/lib/api/providers.ts';
import { PROVIDER_APIS, updateProvider } from '@/lib/api/providers.ts';
import { type HeaderRow, headerPayload, headerRowsFromNames, removedHeaderNames } from '@/lib/header-rows.ts';
import { requestErrorMessage } from '@/lib/model-manager.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';

const API_LABELS: Record<ProviderApi, string> = {
  'openai-completions': 'openai-completions',
  'openai-responses': 'openai-responses',
  'anthropic-messages': 'anthropic-messages',
  'google-generative-ai': 'google-generative-ai',
};

/**
 * Connection fields of one provider. Builtin providers keep Pi's address and
 * adapter (read-only); only their key can change. Secrets are write-only: the
 * panel shows an empty password field, never a value and never a reveal button.
 */
export function ProviderConnectionCard({
  provider,
  revision,
  onDetect,
}: {
  readonly provider: ProviderView;
  readonly revision: string;
  readonly onDetect: () => void;
}): React.ReactElement {
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
  const [apiKey, setApiKey] = useState('');
  const [headers, setHeaders] = useState<readonly HeaderRow[]>(() => headerRowsFromNames(provider.header_names));
  const [localError, setLocalError] = useState<string | null>(null);

  const base = baseline.provider;
  const custom = base.kind === 'custom';
  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  const baseUrlChanged = custom && trimmedBaseUrl !== base.base_url;
  const apiChanged = custom && api !== base.api;
  const removed = removedHeaderNames(base.header_names, headers);
  const payload = headerPayload(headers, removed);
  const dirty = baseUrlChanged || apiChanged || apiKey.length > 0 || payload.headers !== undefined;
  const stale = revision !== baseline.revision;

  const resetDrafts = (next: ProviderView, nextRevision: string): void => {
    setBaseline({ provider: next, revision: nextRevision });
    setBaseUrl(next.base_url);
    setApi(next.api);
    setApiKey('');
    setHeaders(headerRowsFromNames(next.header_names));
    setLocalError(null);
  };

  // Untouched drafts simply follow the server. Edited ones wait for an explicit
  // reload, so a refresh never silently merges into what the admin typed.
  useEffect(() => {
    if (stale && !dirty) {
      setBaseline({ provider, revision });
      setBaseUrl(provider.base_url);
      setApi(provider.api);
      setHeaders(headerRowsFromNames(provider.header_names));
    }
  }, [stale, dirty, provider, revision]);

  const save = useMutation({
    mutationFn: (body: UpdateProviderRequest) => updateProvider(base.alias, body, baseline.revision),
    onSuccess: (result) => {
      const saved = result.providers.find((candidate) => candidate.alias === base.alias);
      setApiKey('');
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
    if (baseUrlChanged) {
      // Moving the address without re-entering the credentials would let a
      // stolen session point a stored key at another server.
      if (apiKey.length === 0) {
        setLocalError(t('models.models.connection.needsApiKey'));
        return;
      }
      const missing = base.header_names.filter((name) => !headers.some((row) => row.existing && row.name === name));
      if (missing.length > 0) {
        setLocalError(t('models.models.connection.headerRemoved', { names: missing.join(', ') }));
        return;
      }
      if (headers.some((row) => row.existing && row.value.length === 0)) {
        setLocalError(t('models.models.headers.valuesRequired'));
        return;
      }
    }
    const body: UpdateProviderRequest = {
      ...(baseUrlChanged ? { base_url: trimmedBaseUrl } : {}),
      ...(apiChanged ? { api } : {}),
      ...(apiKey.length > 0 ? { api_key: apiKey } : {}),
      ...(payload.headers === undefined ? {} : { headers: payload.headers }),
    };
    setLocalError(null);
    save.mutate(body);
  };

  const error = localError;

  return (
    <Panel
      title={t('models.models.connection.title')}
      action={
        <>
          <Button variant="outline" color="secondary" onClick={onDetect}>
            {t('models.models.connection.test')}
          </Button>
          <Button
            disabled={!dirty || stale}
            loading={save.isPending}
            loadingLabel={t('common.saving')}
            onClick={submit}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
        {custom ? (
          <>
            <Field label={t('models.models.connection.baseUrl')}>
              <Input
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                  setLocalError(null);
                }}
              />
            </Field>
            <Field
              label={t('models.models.connection.api')}
              {...(api === 'google-generative-ai' ? { help: t('models.models.connection.googleNote') } : {})}
            >
              <Select
                value={api}
                onChange={(event) => setApi(event.target.value as ProviderApi)}
                options={PROVIDER_APIS.map((value) => ({ value, label: API_LABELS[value] }))}
              />
            </Field>
          </>
        ) : (
          <KvList
            columns={1}
            items={[
              {
                label: t('models.models.connection.builtinProvider'),
                value: <MonoValue value={provider.provider ?? ''} />,
              },
              { label: t('models.models.connection.baseUrl'), value: <MonoValue value={provider.base_url} /> },
              { label: t('models.models.connection.api'), value: <MonoValue value={provider.api} /> },
            ]}
          />
        )}

        <Field
          label={t('models.models.connection.apiKey')}
          help={
            baseUrlChanged
              ? `${t('models.models.connection.keepHint')}${t('common.separator')}${t('models.models.connection.keepHintChanged')}`
              : t('models.models.connection.keepHint')
          }
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              setLocalError(null);
            }}
          />
        </Field>

        {custom ? (
          <div className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
            <h3 className={css({ margin: '0', textStyle: 'label' })}>{t('models.models.connection.headersTitle')}</h3>
            <HeaderFields
              rows={headers}
              onChange={(rows) => {
                setHeaders(rows);
                setLocalError(null);
              }}
              valuesRequired={baseUrlChanged}
              idPrefix="provider"
            />
          </div>
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
      </div>
    </Panel>
  );
}
