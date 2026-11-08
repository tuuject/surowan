import { useMutation } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Textarea } from '@tuuject/koi-react/textarea';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MonoValue } from '@/components/business';
import { HeaderFields } from '@/components/models/header-fields';
import { ModelDraftList } from '@/components/models/model-draft-list';
import { ModelEditDialog } from '@/components/models/model-edit-dialog';
import { useDraftSelection } from '@/components/models/use-draft-selection';
import type { DiscoveredModel, ProviderModelConfig, ProviderView } from '@/lib/api/providers.ts';
import { appendProviderModels, discoverProviderModels, lookupModelMetadata } from '@/lib/api/providers.ts';
import { type HeaderRow, headerRowsFromNames, headerValues } from '@/lib/header-rows.ts';
import { modelFormFromDraft } from '@/lib/model-form.ts';
import { parseModelIds, requestErrorMessage } from '@/lib/model-manager.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';

export type ModelPickerMode = 'discover' | 'manual';

/**
 * Adds models to an existing provider: fetch the provider's list and resolve
 * metadata, or look up ids the admin typed in. Neither path writes anything
 * until the selection is submitted, and a draft with unconfirmed fields cannot
 * be submitted before it went through the edit dialog.
 */
export function ModelPickerDialog({
  mode,
  provider,
  revision,
  onClose,
}: {
  readonly mode: ModelPickerMode;
  readonly provider: ProviderView;
  readonly revision: string;
  readonly onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const write = useProviderWrite();
  const selection = useDraftSelection();
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [tempMode, setTempMode] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [headers, setHeaders] = useState<readonly HeaderRow[]>(() => headerRowsFromNames(provider.header_names));
  const [ids, setIds] = useState('');
  const [editing, setEditing] = useState<DiscoveredModel | null>(null);
  // models.dev is one metadata source among several; when it is unreachable the
  // listing still works, and this is what the admin has to know about the rest.
  const [metadataError, setMetadataError] = useState<string | null>(null);

  const connection =
    provider.kind === 'builtin'
      ? { kind: 'builtin' as const, provider: provider.provider ?? '' }
      : { kind: 'custom' as const, base_url: provider.base_url, api: provider.api };

  const discover = useMutation({
    mutationFn: async () => {
      if (!tempMode) {
        return await discoverProviderModels({ alias: provider.alias });
      }
      const payload = headerValues(headers);
      if (payload.error !== null) {
        throw new Error(payload.error);
      }
      if (apiKey.length === 0) {
        throw new Error(t('models.models.picker.tempModeKeyNeeded'));
      }
      return await discoverProviderModels({
        ...connection,
        api_key: apiKey,
        ...(payload.values === undefined ? {} : { headers: payload.values }),
      });
    },
    onSuccess: (result) => {
      setEndpoint(result.endpoint);
      setMetadataError(result.metadata_source_error);
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
      return {
        metadataSourceError: result.metadata_source_error,
        models: result.models.map((draft) => ({ ...draft, configured: false })),
      };
    },
    onSuccess: ({ models, metadataSourceError }) => {
      setMetadataError(metadataSourceError);
      selection.replaceDrafts(models);
      // A single id goes straight into the edit dialog, which is where its
      // metadata is confirmed; several ids are picked from the list first.
      const only = models.length === 1 ? models[0] : undefined;
      if (only !== undefined) {
        setEditing(only);
      }
    },
  });

  const append = useMutation({
    mutationFn: (models: readonly ProviderModelConfig[]) => appendProviderModels(provider.alias, models, revision),
    onSuccess: (result) => {
      write.succeeded(result.apply);
      onClose();
    },
    onError: (error) => {
      write.failed(error);
    },
  });

  const fetchError = mode === 'discover' ? discover.error : lookup.error;
  const fetchPending = mode === 'discover' ? discover.isPending : lookup.isPending;
  const blocked = selection.selectedCount === 0 || selection.models === null;

  return (
    <>
      <Dialog
        open
        onOpenChange={(next) => {
          if (!next) {
            onClose();
          }
        }}
        title={mode === 'discover' ? t('models.models.picker.discoverTitle') : t('models.models.picker.manualTitle')}
        description={t(
          mode === 'discover' ? 'models.models.picker.discoverDescription' : 'models.models.picker.manualDescription',
          { alias: provider.alias, api: provider.api },
        )}
        size="lg"
        footer={
          <>
            <Button type="button" variant="ghost" color="secondary" disabled={append.isPending} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={append.isPending || blocked}
              onClick={() => {
                if (selection.models !== null) {
                  append.mutate(selection.models);
                }
              }}
            >
              {append.isPending
                ? t('models.models.picker.adding')
                : t(selection.selectedCount === 1 ? 'models.models.picker.addOne' : 'models.models.picker.addMany', {
                    count: selection.selectedCount,
                  })}
            </Button>
          </>
        }
      >
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
          {mode === 'discover' ? (
            <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
              <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
                <Button
                  type="button"
                  variant="ghost"
                  color="secondary"
                  size="sm"
                  onClick={() => setTempMode((previous) => !previous)}
                >
                  {tempMode ? t('models.models.picker.useSaved') : t('models.models.picker.useTemp')}
                </Button>
                {endpoint === null ? null : (
                  <span className={css({ textStyle: 'small', color: 'text-muted' })}>
                    {t('models.models.picker.endpointLabel')}
                    <MonoValue value={endpoint} />
                  </span>
                )}
              </div>
              {tempMode ? (
                <div
                  className={css({
                    '& > :not(:last-child)': { marginBlockEnd: '3' },
                    borderRadius: 'lg',
                    borderWidth: '1px',
                    borderColor: 'border',
                    padding: '3',
                  })}
                >
                  <Field id="picker-api-key" label={t('models.models.connection.apiKey')}>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                    />
                  </Field>
                  {provider.kind === 'custom' && provider.header_names.length > 0 ? (
                    <HeaderFields rows={headers} onChange={setHeaders} valuesRequired={false} />
                  ) : null}
                </div>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                color="secondary"
                disabled={fetchPending}
                onClick={() => {
                  discover.mutate();
                }}
              >
                {fetchPending
                  ? t('models.models.picker.fetching')
                  : selection.drafts.length === 0
                    ? t('models.models.picker.fetch')
                    : t('models.models.picker.fetchAgain')}
              </Button>
            </div>
          ) : (
            <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
              <Field label={t('models.models.picker.idsLabel')}>
                <Textarea
                  rows={3}
                  value={ids}
                  onChange={(event) => setIds(event.target.value)}
                  placeholder={'deepseek/deepseek-v4-flash\nqwen/qwen3-max'}
                />
              </Field>
              <Button
                type="button"
                size="sm"
                variant="outline"
                color="secondary"
                disabled={fetchPending}
                onClick={() => {
                  lookup.mutate();
                }}
              >
                {fetchPending ? t('models.models.picker.lookingUp') : t('models.models.wizard.lookup')}
              </Button>
            </div>
          )}

          {fetchError === null ? null : (
            <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
              {requestErrorMessage(fetchError)}
            </p>
          )}

          {metadataError === null ? null : (
            <p className={css({ textStyle: 'small', color: 'text-muted', overflowWrap: 'anywhere' })}>
              {t('models.models.picker.metadataUnavailable', { error: metadataError })}
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
          {append.isError ? (
            <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
              {requestErrorMessage(append.error)}
            </p>
          ) : null}
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
          api={provider.api}
          title={t('models.models.wizard.confirmTitle', { model: editing.id })}
          description={t('models.models.wizard.confirmDescription')}
          initial={modelFormFromDraft(editing, provider.api)}
          lockId
          draft={editing}
          pending={false}
          error={null}
          onSubmit={(model) => {
            selection.resolve(editing.id, model);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}
