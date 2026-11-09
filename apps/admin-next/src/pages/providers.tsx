import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Empty } from '@tuuject/koi-react/empty';
import { TrashIcon } from '@tuuject/koi-react/icons';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { ListPageHeader } from '@/components/business';
import { ModelList, type ModelRow } from '@/components/models/model-list';
import {
  type DeletingModelTarget,
  type EditingTarget,
  ModelsDialogs,
  type PickerTarget,
} from '@/components/models/models-dialogs';
import { ModelsPageError, ModelsPageLoading } from '@/components/models/models-page-states';
import { ProviderConnectionSection } from '@/components/models/provider-connection-section';
import { ProviderDetailHeader } from '@/components/models/provider-detail-header';
import { ProviderRail } from '@/components/models/provider-list';
import { ProvidersRestartBanner } from '@/components/models/restart-banner';
import { ThinkingResetDialog } from '@/components/models/roles/thinking-reset-dialog';
import { modelRoles, useModelRoleWrites } from '@/components/models/roles/writes';
import { AppLink } from '@/components/router-links';
import type { HealthCheckResult, ProviderModelConfig, ProviderView } from '@/lib/api/providers.ts';
import {
  deleteProvider,
  deleteProviderModels,
  healthCheckProviderModel,
  replaceProviderModel,
} from '@/lib/api/providers.ts';
import { errorMessage } from '@/lib/errors.ts';
import { useListQuery } from '@/lib/list-query';
import { isConfigConflict, providerMatchesSearch, providerUsage, writeErrorMessage } from '@/lib/model-manager.ts';
import { providersQuery } from '@/lib/queries.ts';
import { toast } from '@/lib/toast.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';

const EMPTY_FILTERS = { search: '' };

/**
 * The Providers page: the provider registry and each provider's models, their
 * health checks, and one-click role assignment from every model row. Which
 * model fills each role, and at what effort, is the Models page's job.
 */
export default function ProvidersPage(): ReactElement {
  const { t } = useTranslation();
  const write = useProviderWrite();
  const providers = useQuery(providersQuery);
  const query = useListQuery(EMPTY_FILTERS);
  const search = query.value.search;
  const [selectedAlias, setSelectedAlias] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  // The revision travels with the snapshot the edit form starts from, so a save
  // can never pass the concurrency check with a form built from older data.
  const [editing, setEditing] = useState<EditingTarget | null>(null);
  // Each confirmation keeps `open` apart from its target, so closing never blanks the text mid-fade.
  const [deletingModels, setDeletingModels] = useState<readonly DeletingModelTarget[]>([]);
  const [deleteModelOpen, setDeleteModelOpen] = useState(false);
  const [deletingProvider, setDeletingProvider] = useState<ProviderView | null>(null);
  const [deleteProviderOpen, setDeleteProviderOpen] = useState(false);
  // Model selection is shared by testing and deletion and survives provider
  // switches. Keys resolve against the live registry before either operation.
  const [healthSelected, setHealthSelected] = useState<ReadonlySet<string>>(new Set());
  const [health, setHealth] = useState<Record<string, HealthCheckResult | 'checking'>>({});
  const healthBatch = useRef<AbortController | null>(null);
  // Leaving the page must not keep charging for a queued batch in the background.
  useEffect(() => () => healthBatch.current?.abort(), []);

  const view = providers.data;
  const revision = view?.revision ?? '';
  const roles = useModelRoleWrites(view);

  // Selection keys resolve back to provider/model through the live model list,
  // so model ids containing `/` never need splitting.
  const healthRefs = useMemo(() => {
    const map = new Map<string, { readonly provider: string; readonly model: string }>();
    for (const provider of view?.providers ?? []) {
      for (const model of provider.models) {
        map.set(`${provider.alias}/${model.id}`, { provider: provider.alias, model: model.id });
      }
    }
    return map;
  }, [view]);
  const runnableSelected = useMemo(
    () => [...healthSelected].filter((key) => healthRefs.has(key)),
    [healthSelected, healthRefs],
  );
  const running = Object.values(health).some((entry) => entry === 'checking');

  /**
   * Runs the probe for each key, at most three in flight. Results land in
   * `health` as they finish; thrown HTTP/validation errors become per-item
   * error results so one failure never blanks the batch.
   */
  const runHealthChecks = async (keys: readonly string[]): Promise<void> => {
    if (healthBatch.current !== null) {
      return;
    }
    const controller = new AbortController();
    healthBatch.current = controller;
    setHealth((previous) => {
      const next: Record<string, HealthCheckResult | 'checking'> = { ...previous };
      for (const key of keys) {
        next[key] = 'checking';
      }
      return next;
    });
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (!controller.signal.aborted && cursor < keys.length) {
        const key = keys[cursor];
        cursor += 1;
        if (key === undefined) {
          continue;
        }
        const ref = healthRefs.get(key);
        if (ref === undefined) {
          continue;
        }
        const started = performance.now();
        try {
          const result = await healthCheckProviderModel(ref, controller.signal);
          if (controller.signal.aborted) {
            return;
          }
          setHealth((previous) => ({ ...previous, [key]: result }));
        } catch (error) {
          if (controller.signal.aborted) {
            return;
          }
          setHealth((previous) => ({
            ...previous,
            [key]: {
              provider: ref.provider,
              model: ref.model,
              status: 'error',
              ttfb_ms: null,
              duration_ms: Math.round(performance.now() - started),
              response_text: '',
              error: errorMessage(error),
            },
          }));
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(3, keys.length) }, () => worker()));
    } finally {
      healthBatch.current = null;
    }
  };

  const saveModel = useMutation({
    mutationFn: ({
      alias,
      model,
      revision: formRevision,
    }: {
      readonly alias: string;
      readonly model: ProviderModelConfig;
      readonly revision: string;
    }) => replaceProviderModel(alias, model.id, model, formRevision),
    onSuccess: (result) => {
      setEditing(null);
      write.succeeded(result.apply);
    },
    onError: (error) => {
      write.failed(error);
      if (isConfigConflict(error)) {
        // Retrying this form would overwrite whatever changed on the server, so
        // it closes; reopening starts from the refreshed definition.
        setEditing(null);
        saveModel.reset();
        toast.error(t('models.models.page.editConflictToast'));
      }
    },
  });

  const removeModel = useMutation({
    mutationFn: (targets: readonly DeletingModelTarget[]) =>
      deleteProviderModels(
        targets.map((target) => ({ provider: target.alias, model: target.model })),
        revision,
      ),
    onSuccess: (result, targets) => {
      setDeleteModelOpen(false);
      setHealthSelected((previous) => {
        const next = new Set(previous);
        for (const target of targets) {
          next.delete(`${target.alias}/${target.model}`);
        }
        return next;
      });
      write.succeeded(result.apply);
    },
    onError: (error) => {
      write.failed(error);
    },
  });

  const removeProvider = useMutation({
    mutationFn: (alias: string) => deleteProvider(alias, revision),
    onSuccess: (result) => {
      setDeleteProviderOpen(false);
      setSelectedAlias(null);
      write.succeeded(result.apply);
    },
    onError: (error) => {
      write.failed(error);
    },
  });

  if (providers.isPending) {
    return <ModelsPageLoading />;
  }

  if (view === undefined) {
    return <ModelsPageError error={providers.error} />;
  }

  const listed = view.providers.filter((provider) => providerMatchesSearch(provider, search));
  const selected =
    view.providers.find((provider) => provider.alias === selectedAlias) ?? listed[0] ?? view.providers[0] ?? null;
  const selectedUsage = selected === null ? null : providerUsage(view, selected.alias);

  const rows: readonly ModelRow[] =
    selected === null ? [] : selected.models.map((model) => ({ alias: selected.alias, api: selected.api, model }));

  const pickerProvider = picker === null ? null : (view.providers.find((p) => p.alias === picker.alias) ?? null);

  const saveEdit = (model: ProviderModelConfig): void => {
    if (editing !== null) {
      saveModel.mutate({ alias: editing.alias, model, revision: editing.revision });
    }
  };

  const selectedModels = runnableSelected.flatMap((key) => {
    const ref = healthRefs.get(key);
    return ref === undefined ? [] : [{ alias: ref.provider, model: ref.model }];
  });
  const selectedModelsInUse = selectedModels.some((target) => {
    const assigned = modelRoles(view, target.alias, target.model);
    return assigned.agent || assigned.vision || assigned.tool;
  });
  const confirmModelDeletion = (targets: readonly DeletingModelTarget[]): void => {
    removeModel.reset();
    setDeletingModels(targets);
    setDeleteModelOpen(true);
  };

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '8' } })}>
      <ListPageHeader
        title={t('layout.nav.providers')}
        description={
          <Trans i18nKey="models.models.providers.description" components={{ models: <AppLink to="/models" /> }} />
        }
      />
      {providers.isError ? <Alert tone="error">{errorMessage(providers.error)}</Alert> : null}
      <ProvidersRestartBanner view={view} />

      {/* Master and detail split by one hairline (above the detail when stacked, beside it when wide), not by frames. */}
      <div
        className={css({
          display: 'grid',
          gap: '8',
          alignItems: 'start',
          // 332px = the rail's 308px plus its 24px gutter to the hairline.
          '@media (min-width: 1200px)': { gridTemplateColumns: '332px minmax(0, 1fr)', columnGap: '0' },
        })}
      >
        <aside
          className={css({
            minWidth: '0',
            alignSelf: 'start',
            '@media (min-width: 1200px)': {
              paddingInlineEnd: '6',
              position: 'sticky',
              // The same air under the header and above the window edge; past that the rail's list scrolls on its own.
              top: 'calc(var(--app-header-offset) + token(spacing.6))',
              maxHeight: 'calc(100dvh - var(--app-header-offset) - token(spacing.6) * 2)',
              display: 'flex',
              flexDirection: 'column',
            },
          })}
        >
          <ProviderRail
            view={view}
            listed={listed}
            selected={selected}
            search={search}
            onSearch={(next) => query.apply({ search: next })}
            onSelect={setSelectedAlias}
            onNewProvider={() => setWizardOpen(true)}
            onRefresh={() => void providers.refetch()}
            refreshing={providers.isRefetching}
          />
        </aside>

        <div
          key={selected?.alias ?? 'empty'}
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: '8',
            minWidth: '0',
            paddingBlockStart: '6',
            borderTopWidth: '1px',
            borderColor: 'divider',
            '@media (min-width: 1200px)': {
              // Stretch so the hairline runs the full height even when the rail is the taller column.
              alignSelf: 'stretch',
              paddingBlockStart: '0',
              paddingInlineStart: '6',
              borderTopWidth: '0',
              borderInlineStartWidth: '1px',
            },
          })}
        >
          {selected === null ? (
            <Empty title={t('models.models.page.emptyState')} />
          ) : (
            <>
              <ProviderDetailHeader
                view={view}
                provider={selected}
                action={
                  <Button
                    variant="ghost"
                    color="error"
                    disabled={
                      selectedUsage?.agent === true || selectedUsage?.vision === true || selectedUsage?.tool === true
                    }
                    onClick={() => {
                      removeProvider.reset();
                      setDeletingProvider(selected);
                      setDeleteProviderOpen(true);
                    }}
                    iconStart={<TrashIcon />}
                  >
                    {t('models.models.page.deleteProvider')}
                  </Button>
                }
              />
              <ProviderConnectionSection key={selected.alias} provider={selected} revision={revision} />
              <ModelList
                key={selected.alias}
                view={view}
                rows={rows}
                health={health}
                healthSelected={healthSelected}
                onHealthSelectedChange={setHealthSelected}
                running={running || removeModel.isPending}
                onRunHealthChecks={runHealthChecks}
                runnableSelected={runnableSelected}
                rolePending={roles.pending}
                onAssignRole={roles.assign}
                onEdit={(alias, model) => setEditing({ alias, model, revision })}
                onDeleteModel={(alias, model) => confirmModelDeletion([{ alias, model }])}
                onDeleteSelected={() => confirmModelDeletion(selectedModels)}
                selectedModelsInUse={selectedModelsInUse}
                onFetchModels={() => setPicker({ mode: 'discover', alias: selected.alias, nonce: Date.now() })}
                onAddById={() => setPicker({ mode: 'manual', alias: selected.alias, nonce: Date.now() })}
              />
            </>
          )}
        </div>
      </div>

      <ModelsDialogs
        view={view}
        revision={revision}
        wizardOpen={wizardOpen}
        onWizardClose={() => setWizardOpen(false)}
        onProviderCreated={(alias) => setSelectedAlias(alias)}
        picker={picker}
        pickerProvider={pickerProvider}
        onPickerClose={() => setPicker(null)}
        editing={editing}
        onEditingClose={() => setEditing(null)}
        save={{
          pending: saveModel.isPending,
          error: saveModel.isError ? writeErrorMessage(saveModel.error) : null,
          onSubmit: saveEdit,
        }}
        deletingModels={deletingModels}
        removeModel={{
          open: deleteModelOpen,
          pending: removeModel.isPending,
          error: removeModel.isError ? writeErrorMessage(removeModel.error) : null,
          onConfirm: () => {
            if (deletingModels.length > 0) {
              removeModel.mutate(deletingModels);
            }
          },
          onClose: () => setDeleteModelOpen(false),
        }}
        deletingProvider={deletingProvider}
        removeProvider={{
          open: deleteProviderOpen,
          pending: removeProvider.isPending,
          error: removeProvider.isError ? writeErrorMessage(removeProvider.error) : null,
          onConfirm: () => {
            if (deletingProvider !== null) {
              removeProvider.mutate(deletingProvider.alias);
            }
          },
          onClose: () => setDeleteProviderOpen(false),
        }}
      />
      <ThinkingResetDialog resets={roles.thinkingResets} onClose={roles.closeThinkingResets} />
    </div>
  );
}
