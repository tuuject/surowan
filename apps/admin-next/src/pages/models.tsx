import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { InUsePanel } from '@/components/models/in-use-panel';
import { ModelTable, type ModelRow } from '@/components/models/model-table';
import {
  type DeletingModelTarget,
  type EditingTarget,
  ModelsDialogs,
  type PickerTarget,
} from '@/components/models/models-dialogs';
import { ModelsPageError, ModelsPageLoading } from '@/components/models/models-page-states';
import { ProviderConnectionCard } from '@/components/models/provider-connection-card';
import { ProviderDetailHeader } from '@/components/models/provider-detail-header';
import { ProviderListPanel } from '@/components/models/provider-list';
import { RestartBanner } from '@/components/models/restart-banner';
import { ToolModelPanel } from '@/components/models/tool-model-panel';
import { Card, CardContent } from '@/components/ui/card';

import { errorMessage } from '@/lib/errors.ts';
import { isConfigConflict, providerMatchesSearch, writeErrorMessage } from '@/lib/model-manager.ts';
import { providersQuery } from '@/lib/queries.ts';
import { waitForAdminServer } from '@/lib/restart.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';
import {
  deleteProvider,
  deleteProviderModel,
  healthCheckProviderModel,
  replaceProviderModel,
} from '@/lib/api/providers.ts';
import type { HealthCheckResult, ProviderModelConfig, ProviderView } from '@/lib/api/providers.ts';
import { restartServer } from '@/lib/api/config.ts';
import { switchAgentModel, switchVisionModel } from '@/lib/api/models.ts';

export default function ModelsPage(): React.ReactElement {
  const { t } = useTranslation();
  const write = useProviderWrite();
  const providers = useQuery(providersQuery);
  const [selectedAlias, setSelectedAlias] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  // The revision travels with the snapshot the edit form starts from, so a save
  // can never pass the concurrency check with a form built from older data.
  const [editing, setEditing] = useState<EditingTarget | null>(null);
  const [deletingModel, setDeletingModel] = useState<DeletingModelTarget | null>(null);
  const [deletingProvider, setDeletingProvider] = useState<ProviderView | null>(null);
  // Health-check probes: page-local state, never persisted. The key is the same
  // `${alias}/${model.id}` row key, so a selection survives provider switches.
  const [healthSelected, setHealthSelected] = useState<ReadonlySet<string>>(new Set());
  const [health, setHealth] = useState<Record<string, HealthCheckResult | 'checking'>>({});
  const healthBatch = useRef<AbortController | null>(null);
  // Leaving the page must not keep charging for a queued batch in the background.
  useEffect(() => () => healthBatch.current?.abort(), []);

  const view = providers.data;
  const revision = view?.revision ?? '';
  const restartPaths = useMemo(() => view?.restart_required ?? [], [view]);

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

  const switchAgent = useMutation({
    mutationFn: ({ alias, model }: { readonly alias: string; readonly model: string }) =>
      switchAgentModel({ provider: alias, model }, revision),
    onSuccess: (result) => {
      // Models do not share one set of levels, so the switch always resets it.
      write.succeeded(result.apply, t('models.models.page.thinkingReset', { level: result.current.thinking_level }));
    },
    onError: (error) => {
      toast.error(writeErrorMessage(error));
      write.failed(error);
    },
  });

  const switchVision = useMutation({
    mutationFn: ({ alias, model }: { readonly alias: string; readonly model: string }) =>
      switchVisionModel({ provider: alias, model }, revision),
    onSuccess: (result) => {
      write.succeeded(result.apply);
    },
    onError: (error) => {
      toast.error(writeErrorMessage(error));
      write.failed(error);
    },
  });

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
    mutationFn: ({ alias, model }: { readonly alias: string; readonly model: string }) =>
      deleteProviderModel(alias, model, revision),
    onSuccess: (result) => {
      setDeletingModel(null);
      write.succeeded(result.apply);
    },
    onError: (error) => {
      write.failed(error);
    },
  });

  const removeProvider = useMutation({
    mutationFn: (alias: string) => deleteProvider(alias, revision),
    onSuccess: (result) => {
      setDeletingProvider(null);
      setSelectedAlias(null);
      write.succeeded(result.apply);
    },
    onError: (error) => {
      write.failed(error);
    },
  });

  const restart = useMutation({
    mutationFn: restartServer,
    onSuccess: async () => {
      toast.info(t('models.models.page.restarting'), {
        description: t('models.models.page.restartingDescription'),
      });
      const recovered = await waitForAdminServer();
      write.refresh();
      if (recovered) {
        toast.success(t('models.models.page.serverBack'));
      } else {
        toast.error(t('models.models.page.restartTimeout'));
      }
    },
    onError: (error) => {
      toast.error(writeErrorMessage(error));
    },
  });

  if (providers.isPending) {
    return <ModelsPageLoading />;
  }

  if (providers.isError || view === undefined) {
    return <ModelsPageError error={providers.error} />;
  }

  const listed = view.providers.filter((provider) => providerMatchesSearch(provider, search));
  const selected =
    view.providers.find((provider) => provider.alias === selectedAlias) ?? listed[0] ?? view.providers[0] ?? null;

  const rows: readonly ModelRow[] =
    selected === null ? [] : selected.models.map((model) => ({ alias: selected.alias, api: selected.api, model }));

  const pickerProvider = picker === null ? null : (view.providers.find((p) => p.alias === picker.alias) ?? null);

  const saveEdit = (model: ProviderModelConfig): void => {
    if (editing !== null) {
      saveModel.mutate({ alias: editing.alias, model, revision: editing.revision });
    }
  };

  return (
    <div className="space-y-6">
      <RestartBanner
        paths={restartPaths}
        supervised={view.supervised}
        pending={restart.isPending}
        onRestart={() => restart.mutate()}
      />

      <InUsePanel view={view} revision={revision} />

      <ToolModelPanel key={`${view.tool_model.provider}/${view.tool_model.model}`} view={view} revision={revision} />

      {/* `grid-cols-1` on a phone: an implicit `auto` track grows to the model
          table's min-content and scrolls the whole page sideways. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <ProviderListPanel
          view={view}
          listed={listed}
          selected={selected}
          search={search}
          onSearchChange={setSearch}
          onSelect={setSelectedAlias}
          onNewProvider={() => setWizardOpen(true)}
        />

        <div className="space-y-6">
          {selected === null ? (
            <Card>
              <CardContent className="text-muted-foreground py-8 text-center text-sm">
                {t('models.models.page.emptyState')}
              </CardContent>
            </Card>
          ) : (
            <>
              <ProviderDetailHeader view={view} provider={selected} onDelete={() => setDeletingProvider(selected)} />

              <ProviderConnectionCard
                key={selected.alias}
                provider={selected}
                revision={revision}
                onDetect={() => setPicker({ mode: 'discover', alias: selected.alias, nonce: Date.now() })}
              />

              <ModelTable
                view={view}
                rows={rows}
                health={health}
                healthSelected={healthSelected}
                onHealthSelectedChange={setHealthSelected}
                running={running}
                onRunHealthChecks={runHealthChecks}
                runnableSelected={runnableSelected}
                agentPending={switchAgent.isPending}
                visionPending={switchVision.isPending}
                onSetAgent={(alias, model) => switchAgent.mutate({ alias, model })}
                onSetVision={(alias, model) => switchVision.mutate({ alias, model })}
                onEdit={(alias, model) => setEditing({ alias, model, revision })}
                onDeleteModel={(alias, model) => setDeletingModel({ alias, model })}
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
        deletingModel={deletingModel}
        onDeletingModelClose={() => setDeletingModel(null)}
        removeModel={{
          pending: removeModel.isPending,
          error: removeModel.isError ? writeErrorMessage(removeModel.error) : null,
          onConfirm: () => {
            if (deletingModel !== null) {
              removeModel.mutate(deletingModel);
            }
          },
        }}
        deletingProvider={deletingProvider}
        onDeletingProviderClose={() => setDeletingProvider(null)}
        removeProvider={{
          pending: removeProvider.isPending,
          error: removeProvider.isError ? writeErrorMessage(removeProvider.error) : null,
          onConfirm: () => {
            if (deletingProvider !== null) {
              removeProvider.mutate(deletingProvider.alias);
            }
          },
        }}
      />
    </div>
  );
}
