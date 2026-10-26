import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Panel } from '@/components/layout/panel';
import { errorMessage } from '@/lib/errors';
import { isConfigConflict } from '@/lib/model-manager';
import { configStatusQuery } from '@/lib/queries';
import { putSearchConfig, type SearchConfigView } from '@/lib/api/search.ts';
import { EngineEditor } from './engine-editor.tsx';
import { activeEngineCount, buildPayload, emptyDraft, toDraft, validate, type EngineDraft } from './draft.ts';
import { UrlFilterEditor } from './url-filters.tsx';

/** The editable form. Its identity is the revision, so a new revision remounts it. */
export function SearchSettingsForm({ initial }: { initial: SearchConfigView }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [engines, setEngines] = useState<EngineDraft[]>(() => initial.engines.map(toDraft));
  const [filters, setFilters] = useState(initial.url_filters.join('\n'));
  const providers = initial.providers;
  const providerById = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);

  const payload = useMemo(
    () => buildPayload(enabled, engines, filters, providerById),
    [enabled, engines, filters, providerById],
  );
  const errors = useMemo(() => validate(payload, providers), [payload, providers]);
  const activeEngines = activeEngineCount(payload.engines);

  const save = useMutation({
    mutationFn: () => putSearchConfig(payload, initial.revision),
    onSuccess: (result) => {
      queryClient.setQueryData(['search-config'], result);
      void queryClient.invalidateQueries({ queryKey: configStatusQuery.queryKey });
      toast.success(t('search.saved'));
    },
  });

  const update = (key: string, change: Partial<EngineDraft>): void => {
    setEngines((current) => current.map((engine) => (engine.key === key ? { ...engine, ...change } : engine)));
  };

  const addEngine = (): void => {
    const provider = providers[0];
    if (provider === undefined) {
      return;
    }
    setEngines((current) => [...current, emptyDraft(provider, current)]);
  };

  return (
    <div className="space-y-6">
      <Panel title={t('search.switchTitle')}>
        <p className="text-muted-foreground mb-3 text-sm">{t('search.switchDescription')}</p>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="search-enabled">{t('search.switchLabel')}</Label>
            <p className="text-muted-foreground text-sm">
              {enabled && activeEngines > 0 ? t('search.switchActive') : t('search.switchInactive')}
            </p>
          </div>
          <Switch
            id="search-enabled"
            checked={enabled}
            onCheckedChange={(next) => setEnabled(next)}
            disabled={save.isPending}
          />
        </div>
      </Panel>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle>{t('search.enginesTitle')}</CardTitle>
            <p className="text-muted-foreground text-sm">{t('search.enginesDescription')}</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addEngine}>
            <Plus aria-hidden /> {t('search.addEngine')}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {engines.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('search.noEngines')}</p>
          ) : (
            engines.map((engine, index) => (
              <EngineEditor
                key={engine.key}
                draft={engine}
                providers={providers}
                provider={providerById.get(engine.provider)}
                deepseekKeys={initial.deepseek_keys}
                disabled={save.isPending}
                onChange={(change) => update(engine.key, change)}
                onRemove={() => setEngines((current) => current.filter((entry) => entry.key !== engine.key))}
                index={index}
              />
            ))
          )}
        </CardContent>
      </Card>

      <UrlFilterEditor rules={filters} onRulesChange={setFilters} disabled={save.isPending} />

      {errors.length > 0 ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{t('search.invalidTitle')}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex items-center gap-3">
        <Button
          type="button"
          disabled={save.isPending || errors.length > 0 || (save.isError && isConfigConflict(save.error))}
          onClick={() => save.mutate()}
        >
          {save.isPending ? t('search.saving') : t('search.save')}
        </Button>
        <p className="text-muted-foreground text-xs">{t('search.saveHint')}</p>
      </div>
      {save.isError && isConfigConflict(save.error) ? (
        // The form is keyed by revision, so a refetch remounts it on the
        // current revision; retrying with the stale one could never succeed.
        <Alert variant="destructive" role="alert">
          <AlertTitle>{t('search.conflictTitle')}</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{t('search.conflictBody')}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ['search-config'] })}
            >
              {t('common.reload')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : save.isError ? (
        <p role="alert" className="text-destructive text-sm break-words">
          {errorMessage(save.error)}
        </p>
      ) : null}
    </div>
  );
}
