import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Field } from '@tuuject/koi-react/field';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Textarea } from '@tuuject/koi-react/textarea';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MonoValue } from '@/components/business';
import { ModelDraftList } from '@/components/models/model-draft-list';
import { ModelEditDialog } from '@/components/models/model-edit-dialog';
import { useDraftSelection } from '@/components/models/use-draft-selection';
import { useOpenSession } from '@/hooks/use-open-session.ts';
import type { DiscoveredModel, ProviderModelConfig, ProviderView } from '@/lib/api/providers.ts';
import { appendProviderModels, discoverProviderModels, lookupModelMetadata } from '@/lib/api/providers.ts';
import { modelFormForDraft } from '@/lib/model-form.ts';
import { parseModelIds, requestErrorMessage } from '@/lib/model-manager.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';

export type ModelPickerMode = 'discover' | 'manual';

/**
 * Adds models to an existing provider: fetch the provider's list and resolve
 * metadata, or look up ids the admin typed in. Neither path writes anything
 * until the selection is submitted, and a draft with unconfirmed fields cannot
 * be submitted before it went through the edit dialog.
 *
 * The list is fetched as soon as the picker opens, with the provider's saved
 * connection and key: there is nothing to fill in first. A connection the
 * running process has not applied yet is reported as an error rather than
 * asked for again.
 *
 * The page keeps this mounted and drives it with `open`, so Base UI can play
 * both transitions; `formKey` starts a fresh session on every open and the
 * provider is the snapshot the picker was opened for.
 */
export function ModelPickerDialog({
  open,
  onOpenChange,
  formKey,
  mode,
  provider,
  revision,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Incremented by the page for every open: a new session, not a new dialog. */
  readonly formKey: number;
  readonly mode: ModelPickerMode;
  readonly provider: ProviderView;
  readonly revision: string;
}): ReactElement {
  const { t } = useTranslation();
  const write = useProviderWrite();
  const selection = useDraftSelection();
  // A lookup can be abandoned by closing the picker, and it still answers. Each
  // request carries the session it started in, so a late answer can neither
  // open a confirm over a closed picker nor hand one provider's models to the
  // session opened for another. Discovery gets the same guarantee from its
  // per-session query key.
  const session = useOpenSession(open);
  const [sessionKey, setSessionKey] = useState(formKey);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  // The listing the drafts were last taken from, so a fetch replaces them once.
  const [loadedAt, setLoadedAt] = useState(0);
  const [ids, setIds] = useState('');
  const [editing, setEditing] = useState<DiscoveredModel | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmNonce, setConfirmNonce] = useState(0);
  // The errors are kept apart from the mutation objects: a mutation from the
  // previous session must not surface in this one.
  const [fetchError, setFetchError] = useState<unknown>(null);
  const [appendError, setAppendError] = useState<unknown>(null);
  // models.dev is one metadata source among several; when it is unreachable the
  // listing still works, and this is what the admin has to know about the rest.
  const [metadataError, setMetadataError] = useState<string | null>(null);

  const connection =
    provider.kind === 'builtin'
      ? { kind: 'builtin' as const, provider: provider.provider ?? '' }
      : { kind: 'custom' as const, base_url: provider.base_url, api: provider.api };

  // One query per open: the key carries the session, so an answer that lands
  // after the picker was closed and reopened belongs to a query nobody reads.
  const discovery = useQuery({
    queryKey: ['provider-discover', provider.alias, formKey],
    queryFn: () => discoverProviderModels({ alias: provider.alias }),
    enabled: open && mode === 'discover',
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });

  /** Opens the per-model confirm with the draft as it stands now. */
  const openConfirm = (draft: DiscoveredModel): void => {
    setEditing(draft);
    setConfirmNonce((previous) => previous + 1);
    setConfirmOpen(true);
  };

  const lookup = useMutation({
    mutationFn: async (_startedIn: number) => {
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
    onSuccess: ({ models, metadataSourceError }, startedIn) => {
      if (startedIn !== session.current) {
        return;
      }
      setMetadataError(metadataSourceError);
      setFetchError(null);
      selection.replaceDrafts(models);
      // A single id goes straight into the edit dialog, which is where its
      // metadata is confirmed; several ids are picked from the list first.
      const only = models.length === 1 ? models[0] : undefined;
      if (only !== undefined) {
        openConfirm(only);
      }
    },
    onError: (error, startedIn) => {
      if (startedIn === session.current) {
        setFetchError(error);
      }
    },
  });

  const append = useMutation({
    mutationFn: (models: readonly ProviderModelConfig[]) => appendProviderModels(provider.alias, models, revision),
    onSuccess: (result) => {
      write.succeeded(result.apply);
      onOpenChange(false);
    },
    onError: (error) => {
      write.failed(error);
      setAppendError(error);
    },
  });

  // Every open starts a fresh session: the fields, the drafts and the errors
  // belong to the open they were made in. Resetting here instead of on close is
  // what keeps the body on screen while the exit transition plays.
  if (sessionKey !== formKey) {
    setSessionKey(formKey);
    setEndpoint(null);
    setLoadedAt(0);
    setIds('');
    setMetadataError(null);
    setFetchError(null);
    setAppendError(null);
    setEditing(null);
    setConfirmOpen(false);
    selection.reset();
  }

  // Each listing that arrives — the first one and every "Fetch again" — starts
  // the selection over from its drafts.
  if (mode === 'discover' && discovery.data !== undefined && discovery.dataUpdatedAt !== loadedAt) {
    setLoadedAt(discovery.dataUpdatedAt);
    setEndpoint(discovery.data.endpoint);
    setMetadataError(discovery.data.metadata_source_error);
    selection.replaceDrafts(discovery.data.models);
  }

  const fetchPending = mode === 'discover' ? discovery.isFetching : lookup.isPending;
  const shownFetchError = mode === 'discover' ? (discovery.isError ? discovery.error : null) : fetchError;
  const blocked = selection.selectedCount === 0 || selection.models === null;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          // An append in flight closes the picker when it lands; it must land
          // in the session that started it.
          if (!next && !append.isPending) {
            onOpenChange(false);
          }
        }}
        title={mode === 'discover' ? t('models.models.picker.discoverTitle') : t('models.models.picker.manualTitle')}
        description={t(
          mode === 'discover' ? 'models.models.picker.discoverDescription' : 'models.models.picker.manualDescription',
          { alias: provider.alias },
        )}
        size="lg"
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              color="secondary"
              disabled={append.isPending}
              onClick={() => onOpenChange(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={append.isPending || blocked}
              onClick={() => {
                if (selection.models !== null) {
                  setAppendError(null);
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
            <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                color="secondary"
                disabled={fetchPending}
                onClick={() => {
                  void discovery.refetch();
                }}
              >
                {fetchPending ? t('models.models.picker.fetching') : t('models.models.picker.fetchAgain')}
              </Button>
              {endpoint === null ? null : (
                <span className={css({ textStyle: 'small', color: 'text-muted' })}>
                  {t('models.models.picker.endpointLabel')}
                  <MonoValue value={endpoint} />
                </span>
              )}
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
                  setFetchError(null);
                  lookup.mutate(session.current);
                }}
              >
                {fetchPending ? t('models.models.picker.lookingUp') : t('models.models.wizard.lookup')}
              </Button>
            </div>
          )}

          {shownFetchError === null ? null : (
            <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
              {requestErrorMessage(shownFetchError)}
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
                onEdit={openConfirm}
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
          {appendError === null ? null : (
            <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
              {requestErrorMessage(appendError)}
            </p>
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
        api={provider.api}
        title={editing === null ? '' : t('models.models.wizard.confirmTitle', { model: editing.id })}
        description={t('models.models.wizard.confirmDescription')}
        initial={modelFormForDraft(
          editing,
          editing === null ? undefined : selection.resolved[editing.id],
          provider.api,
        )}
        formKey={confirmNonce}
        lockId
        draft={editing}
        pending={false}
        error={null}
        onSubmit={(model) => {
          if (editing !== null) {
            selection.resolve(editing.id, model);
          }
          setConfirmOpen(false);
        }}
      />
    </>
  );
}
